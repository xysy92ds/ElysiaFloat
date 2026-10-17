package com.elly.assistant

import android.util.Xml
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.zip.Inflater
import java.util.zip.ZipInputStream

/**
 * 文件正文提取（G7-1）。零第三方依赖，只用 JDK/Android 自带能力。
 *
 * 支持：
 *  · 纯文本族：txt / md / json / csv / log / html / xml / yaml / ini / js / kt / py …
 *  · Office（zip + xml）：docx / xlsx / pptx
 *  · 电子书：epub（按 spine 顺序取正文）
 *  · 压缩包：zip 只列清单，不解压内容
 *  · PDF：解析未压缩或 FlateDecode 的文本对象（扫描版/加密件会明确返回失败原因）
 *
 * 安全：条目数、解压总量、单条目大小、输出字符数全部设上限，防 zip bomb。
 */
object FileExtractor {
    private const val MAX_CHARS = 400_000          // 返回给模型的正文上限
    private const val MAX_ENTRIES = 3000
    private const val MAX_TOTAL_INFLATE = 80L * 1024 * 1024
    private const val MAX_ENTRY_BYTES = 24 * 1024 * 1024
    private const val MAX_PDF_STREAM = 12 * 1024 * 1024

    private val TEXT_EXT = setOf(
        "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "ini", "cfg", "conf",
        "yaml", "yml", "xml", "html", "htm", "css", "js", "mjs", "ts", "jsx", "tsx",
        "kt", "java", "py", "sh", "bat", "c", "cc", "cpp", "h", "hpp", "go", "rs", "rb",
        "php", "sql", "gradle", "properties", "srt", "vtt", "tex"
    )

    fun extOf(name: String): String = name.substringAfterLast('.', "").lowercase()

    fun isTextLike(name: String, mime: String): Boolean {
        val m = mime.lowercase()
        if (m.startsWith("text/")) return true
        if (m.contains("json") || m.contains("xml") || m.contains("javascript") ||
            m.contains("yaml") || m.contains("x-sh") || m.contains("csv")
        ) return true
        return TEXT_EXT.contains(extOf(name))
    }

    /**
     * 统一入口。永远返回 JSON，不抛异常。
     * 结构：{ ok, kind, name, chars, text, note? , entries? }
     */
    fun extract(input: InputStream, name: String, mime: String, size: Long): JSONObject {
        val out = JSONObject()
        out.put("name", name)
        out.put("size", size)
        val ext = extOf(name)
        return try {
            when {
                isTextLike(name, mime) -> plainText(input, out)
                ext == "docx" -> docx(input, out)
                ext == "xlsx" -> xlsx(input, out)
                ext == "pptx" -> pptx(input, out)
                ext == "epub" -> epub(input, out)
                ext == "zip" -> zipList(input, out)
                ext == "pdf" -> pdf(input, out)
                else -> out.put("ok", false)
                    .put("kind", "unsupported")
                    .put("note", "暂不支持读取 .$ext 的正文，可以先把内容复制到文本里，或在工作区里让我用命令处理。")
            }
            out
        } catch (e: OutOfMemoryError) {
            out.put("ok", false).put("kind", "too_large").put("note", "文件太大，无法在手机上解析")
        } catch (e: Exception) {
            out.put("ok", false).put("kind", "error").put("note", "解析失败：" + (e.message ?: e.javaClass.simpleName))
        }
    }

    /* ---------------- 纯文本 ---------------- */

    private fun plainText(input: InputStream, out: JSONObject): JSONObject {
        val bytes = readCapped(input, MAX_ENTRY_BYTES) ?: return out.put("ok", false)
            .put("kind", "too_large").put("note", "文件超过 24MB，先不要整份贴进来")
        val text = decodeSmart(bytes)
        out.put("ok", true).put("kind", "text")
        out.put("text", clip(text))
        out.put("chars", text.length)
        if (text.length > MAX_CHARS) out.put("note", "正文较长，已截断到 ${MAX_CHARS} 字")
        return out
    }

    /** 优先 UTF-8；出现大量替换字符时退回 GB18030（中文 txt 常见）。 */
    fun decodeSmart(bytes: ByteArray): String {
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        }
        val utf8 = String(bytes, Charsets.UTF_8)
        val bad = utf8.count { it == '\uFFFD' }
        if (bad <= 2 || bad * 200 < utf8.length) return utf8
        return try { String(bytes, charset("GB18030")) } catch (_: Exception) { utf8 }
    }

    /* ---------------- Office ---------------- */

    private fun docx(input: InputStream, out: JSONObject): JSONObject =
        fromZip(input, out, "docx") { entries ->
            val sb = StringBuilder()
            for (path in listOf("word/document.xml", "word/header1.xml", "word/footer1.xml")) {
                val bytes = entries[path] ?: continue
                collectXmlText(bytes, sb, "t")
                if (sb.isNotEmpty()) sb.append('\n')
            }
            if (sb.isEmpty()) null else sb.toString()
        }

    private fun pptx(input: InputStream, out: JSONObject): JSONObject =
        fromZip(input, out, "pptx") { entries ->
            val slides = entries.keys
                .filter { it.matches(Regex("ppt/slides/slide\\d+\\.xml")) }
                .sortedBy { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
            val sb = StringBuilder()
            slides.forEachIndexed { i, p ->
                val bytes = entries[p] ?: return@forEachIndexed
                sb.append("【第 ${i + 1} 页】\n")
                collectXmlText(bytes, sb, "t")
                sb.append('\n')
            }
            if (sb.isEmpty()) null else sb.toString()
        }

    private fun xlsx(input: InputStream, out: JSONObject): JSONObject =
        fromZip(input, out, "xlsx") { entries ->
            // 共享字符串表 + 每张表的单元格引用
            val shared = mutableListOf<String>()
            entries["xl/sharedStrings.xml"]?.let { bytes ->
                val p = Xml.newPullParser()
                p.setInput(bytes.inputStream(), "utf-8")
                var inSi = false; val cur = StringBuilder()
                while (p.eventType != XmlPullParser.END_DOCUMENT) {
                    when (p.eventType) {
                        XmlPullParser.START_TAG -> if (p.name == "si") { inSi = true; cur.setLength(0) }
                        XmlPullParser.TEXT -> if (inSi) cur.append(p.text ?: "")
                        XmlPullParser.END_TAG -> if (p.name == "si") { inSi = false; shared.add(cur.toString()) }
                    }
                    p.next()
                }
            }
            val sb = StringBuilder()
            val sheets = entries.keys.filter { it.matches(Regex("xl/worksheets/sheet\\d+\\.xml")) }
                .sortedBy { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
            sheets.forEachIndexed { idx, path ->
                sb.append("【工作表 ${idx + 1}】\n")
                val p = Xml.newPullParser()
                entries[path]?.let { p.setInput(it.inputStream(), "utf-8") }
                var row = StringBuilder()
                var cellType = ""
                var cellValue = StringBuilder()
                var inV = false
                while (p.eventType != XmlPullParser.END_DOCUMENT) {
                    when (p.eventType) {
                        XmlPullParser.START_TAG -> when (p.name) {
                            "row" -> row = StringBuilder()
                            "c" -> { cellType = p.getAttributeValue(null, "t") ?: ""; cellValue = StringBuilder() }
                            "v", "t" -> inV = true
                        }
                        XmlPullParser.TEXT -> if (inV) cellValue.append(p.text ?: "")
                        XmlPullParser.END_TAG -> when (p.name) {
                            "v", "t" -> inV = false
                            "c" -> {
                                val v = if (cellType == "s") {
                                    cellValue.toString().toIntOrNull()?.let { shared.getOrNull(it) } ?: ""
                                } else cellValue.toString()
                                if (row.isNotEmpty()) row.append(" | ")
                                row.append(v)
                            }
                            "row" -> if (row.isNotEmpty()) sb.append(row).append('\n')
                        }
                    }
                    p.next()
                }
                sb.append('\n')
            }
            if (sb.isEmpty()) null else sb.toString()
        }

    /* ---------------- epub ---------------- */

    private fun epub(input: InputStream, out: JSONObject): JSONObject =
        fromZip(input, out, "epub") { entries ->
            // 按 container.xml 找 opf，再按 spine 顺序取 xhtml
            val container = entries["META-INF/container.xml"]
            val opfPath = container?.let { bytes ->
                val s = String(bytes, Charsets.UTF_8)
                Regex("full-path\\s*=\\s*\"([^\"]+\\.opf)\"").find(s)?.groupValues?.get(1)
            } ?: entries.keys.firstOrNull { it.endsWith(".opf") }
            val sb = StringBuilder()
            opfPath?.let { opf ->
                val opfText = entries[opf]?.let { String(it, Charsets.UTF_8) } ?: ""
                val base = opf.substringBeforeLast('/', "")
                val ids = Regex("<itemref[^>]*idref\\s*=\\s*\"([^\"]+)\"").findAll(opfText).map { it.groupValues[1] }.toList()
                val hrefById = Regex("<item[^>]*id\\s*=\\s*\"([^\"]+)\"[^>]*href\\s*=\\s*\"([^\"]+)\"")
                    .findAll(opfText).associate { it.groupValues[1] to it.groupValues[2] }
                val ordered = ids.mapNotNull { hrefById[it] }.ifEmpty { hrefById.values.toList() }
                ordered.forEach { href ->
                    val full = if (base.isEmpty()) href else "$base/$href"
                    val bytes = entries[full] ?: entries[href] ?: return@forEach
                    collectXmlText(bytes, sb, null, skipTags = setOf("script", "style"))
                    sb.append('\n')
                }
            }
            if (sb.isEmpty()) {
                // 兜底：随便取几个 xhtml
                entries.keys.filter { it.endsWith(".xhtml") || it.endsWith(".html") }.take(20).forEach {
                    entries[it]?.let { b -> collectXmlText(b, sb, null) }
                    sb.append('\n')
                }
            }
            if (sb.isEmpty()) null else sb.toString()
        }

    /* ---------------- zip ---------------- */

    private fun zipList(input: InputStream, out: JSONObject): JSONObject {
        val arr = JSONArray()
        var total = 0L; var count = 0
        openZip(input) { zis, entry, bytes ->
            count++
            if (count > MAX_ENTRIES) throw IllegalStateException("压缩包条目过多（> $MAX_ENTRIES）")
            total += bytes.size.toLong()
            if (total > MAX_TOTAL_INFLATE) throw IllegalStateException("解压总量超过 80MB")
            arr.put(JSONObject().put("path", entry.name).put("bytes", bytes.size))
        }
        out.put("ok", true).put("kind", "zip").put("entries", arr)
        out.put("text", "压缩包共 $count 个条目：\n" + (0 until minOf(arr.length(), 200)).joinToString("\n") {
            val o = arr.getJSONObject(it)
            "- " + o.optString("path") + "（" + o.optLong("bytes") + " B）"
        })
        return out
    }

    /* ---------------- PDF ---------------- */

    private fun pdf(input: InputStream, out: JSONObject): JSONObject {
        val bytes = readCapped(input, MAX_PDF_STREAM) ?: return out.put("ok", false)
            .put("kind", "too_large").put("note", "PDF 超过 12MB，暂不解析")
        val raw = String(bytes, Charsets.ISO_8859_1)
        if (raw.contains("/Encrypt")) {
            return out.put("ok", false).put("kind", "pdf_encrypted")
                .put("note", "这个 PDF 有加密保护，读不出正文。")
        }
        val sb = StringBuilder()
        var pos = 0
        while (pos < raw.length) {
            val s = raw.indexOf("stream", pos)
            if (s < 0) break
            var start = s + 6
            if (start < raw.length && raw[start] == '\r') start++
            if (start < raw.length && raw[start] == '\n') start++
            val e = raw.indexOf("endstream", start)
            if (e < 0) break
            var data = bytes.copyOfRange(start.coerceAtMost(bytes.size), e.coerceAtMost(bytes.size))
            // 去掉行尾换行
            while (data.isNotEmpty() && (data.last() == '\n'.code.toByte() || data.last() == '\r'.code.toByte())) {
                data = data.copyOfRange(0, data.size - 1)
            }
            val head = raw.substring(maxOf(0, s - 400), s)
            val chunk = if (head.contains("/FlateDecode")) inflate(data) else data
            if (chunk != null) extractPdfText(String(chunk, Charsets.ISO_8859_1), sb)
            pos = e + 9
            if (sb.length > MAX_CHARS) break
        }
        val text = sb.toString().trim()
        if (text.isEmpty()) {
            return out.put("ok", false).put("kind", "pdf_no_text")
                .put("note", "这个 PDF 没有可直接提取的文字（可能是扫描件/图片版）。可以截图给我，我用识图看。")
        }
        out.put("ok", true).put("kind", "pdf").put("text", clip(text)).put("chars", text.length)
        return out
    }

    private fun inflate(data: ByteArray): ByteArray? = try {
        val inf = Inflater()
        inf.setInput(data)
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (!inf.finished()) {
            val n = inf.inflate(buf)
            if (n == 0) {
                if (inf.needsInput() || inf.needsDictionary()) break
            } else {
                total += n
                if (total > MAX_ENTRY_BYTES) break
                bos.write(buf, 0, n)
            }
        }
        inf.end()
        if (total == 0) null else bos.toByteArray()
    } catch (_: Exception) { null }

    /** 从 PDF 内容流里抽 (…)Tj 与 [ … ]TJ 的文字。 */
    private fun extractPdfText(content: String, sb: StringBuilder) {
        var i = 0
        val n = content.length
        fun unescape(s: String): String {
            val o = StringBuilder()
            var k = 0
            while (k < s.length) {
                val c = s[k]
                if (c == '\\' && k + 1 < s.length) {
                    when (val d = s[k + 1]) {
                        'n' -> { o.append('\n'); k += 2 }
                        'r' -> { o.append('\r'); k += 2 }
                        't' -> { o.append('\t'); k += 2 }
                        'b', 'f' -> k += 2
                        '(', ')', '\\' -> { o.append(d); k += 2 }
                        else -> {
                            if (d.isDigit()) {
                                var v = 0; var k2 = k + 1; var cnt = 0
                                while (k2 < s.length && cnt < 3 && s[k2].isDigit()) {
                                    v = v * 8 + (s[k2] - '0'); k2++; cnt++
                                }
                                o.append(v.toChar()); k = k2
                            } else k += 2
                        }
                    }
                } else { o.append(c); k++ }
            }
            return o.toString()
        }
        while (i < n && sb.length < MAX_CHARS) {
            val open = content.indexOf('(', i)
            if (open < 0) break
            // 找配对右括号（处理转义）
            var j = open + 1; var depth = 1; val cur = StringBuilder()
            while (j < n && depth > 0) {
                val c = content[j]
                if (c == '\\' && j + 1 < n) { cur.append(c).append(content[j + 1]); j += 2; continue }
                if (c == '(') depth++
                if (c == ')') { depth--; if (depth == 0) break }
                cur.append(c); j++
            }
            val after = content.substring(j + 1, minOf(n, j + 4))
            if (after.contains("Tj") || after.contains("TJ") || after.contains("'") || after.contains("\"")) {
                val txt = unescape(cur.toString())
                if (txt.isNotBlank()) sb.append(txt)
            }
            i = j + 1
        }
    }

    /* ---------------- 公共 ---------------- */

    private fun fromZip(
        input: InputStream,
        out: JSONObject,
        kind: String,
        pick: (Map<String, ByteArray>) -> String?
    ): JSONObject {
        val entries = readZipEntries(input)
        val text = try { pick(entries) } catch (e: Exception) { null }
        out.put("ok", text != null).put("kind", kind)
        if (text == null) {
            return out.put("note", "没有从这个 .$kind 里读到正文（可能是旧格式或没有文字内容）")
        }
        out.put("text", clip(text)).put("chars", text.length)
        return out
    }

    private fun readZipEntries(input: InputStream): Map<String, ByteArray> {
        val map = LinkedHashMap<String, ByteArray>()
        var total = 0L
        ZipInputStream(input.buffered()).use { zis ->
            while (true) {
                val e = zis.nextEntry ?: break
                if (map.size >= MAX_ENTRIES) break
                if (e.isDirectory) { zis.closeEntry(); continue }
                val bytes = readCapped(zis, MAX_ENTRY_BYTES) ?: ByteArray(0)
                total += bytes.size
                if (total > MAX_TOTAL_INFLATE) break
                map[e.name] = bytes
                zis.closeEntry()
            }
        }
        return map
    }

    private fun openZip(
        input: InputStream,
        onEntry: (ZipInputStream, java.util.zip.ZipEntry, ByteArray) -> Unit
    ) {
        ZipInputStream(input.buffered()).use { zis ->
            while (true) {
                val e = zis.nextEntry ?: break
                if (e.isDirectory) { zis.closeEntry(); continue }
                val bytes = readCapped(zis, MAX_ENTRY_BYTES) ?: ByteArray(0)
                onEntry(zis, e, bytes)
                zis.closeEntry()
            }
        }
    }

    private fun readCapped(input: InputStream, max: Int): ByteArray? {
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            total += n
            if (total > max) return null
            bos.write(buf, 0, n)
        }
        return bos.toByteArray()
    }

    /** 只取 XML 里的文字节点；tag 为 null 表示所有文本。 */
    private fun collectXmlText(
        bytes: ByteArray,
        sb: StringBuilder,
        tag: String?,
        skipTags: Set<String> = emptySet()
    ) {
        val p = Xml.newPullParser()
        p.setInput(bytes.inputStream(), "utf-8")
        var depthSkip = 0
        var inTag = tag == null
        while (p.eventType != XmlPullParser.END_DOCUMENT && sb.length < MAX_CHARS) {
            when (p.eventType) {
                XmlPullParser.START_TAG -> {
                    if (skipTags.contains(p.name.lowercase())) depthSkip++
                    if (tag != null && p.name == tag) inTag = true
                }
                XmlPullParser.TEXT -> {
                    if (inTag && depthSkip == 0) {
                        val t = p.text ?: ""
                        if (t.isNotBlank()) sb.append(t)
                    }
                }
                XmlPullParser.END_TAG -> {
                    if (skipTags.contains(p.name.lowercase()) && depthSkip > 0) depthSkip--
                    if (tag != null && p.name == tag) { inTag = false; sb.append('\n') }
                }
            }
            p.next()
        }
    }

    private fun clip(text: String): String =
        if (text.length <= MAX_CHARS) text else text.substring(0, MAX_CHARS)
}
