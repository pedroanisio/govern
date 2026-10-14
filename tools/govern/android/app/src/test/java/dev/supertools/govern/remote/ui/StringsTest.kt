package dev.supertools.govern.remote.ui

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class StringsTest {
    private fun strings(locale: String): Map<String, String> {
        val file = File("src/main/res/$locale/strings.xml")
        val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).getElementsByTagName("string")
        val result = (0 until nodes.length).map { i ->
            val node = nodes.item(i)
            node.attributes.getNamedItem("name").nodeValue to node.textContent
        }
        assertEquals("duplicate keys", result.size, result.toMap().size)
        return result.toMap()
    }

    @Test fun englishAndPortugueseHaveMatchingKeysAndArguments() {
        val en = strings("values")
        val pt = strings("values-pt-rBR")
        assertEquals(en.keys, pt.keys)
        val format = Regex("%(?:(\\d+)\\$)?(?:[-+0 #]*[0-9]*(?:\\.[0-9]+)?)?[dsf]")
        for (key in en.keys) {
            val a = format.findAll(en.getValue(key)).map { it.value }.sorted().toList()
            val b = format.findAll(pt.getValue(key)).map { it.value }.sorted().toList()
            assertEquals(key, a, b)
        }
        assertEquals("Operação", pt["operation"])
        assertEquals("Atividade", pt["activity"])
    }
}
