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

    @Test fun pairingLabelsExistInBothLanguages() {
        val keys = listOf("pair_step", "pair_headline", "scan_qr", "scan_cancelled", "scan_failed",
            "pair_link", "different_link", "enter_manually", "self_signed_tls", "pair_pin_present",
            "pair_pin_absent", "pair_not_paired", "this_android", "pair_host", "access_requested",
            "pair_all_lanes", "pair_one_lane", "pair_many_lanes", "compare_hint", "copy_command",
            "pair_address_scope", "pair_command", "pair_address_placeholder")
        for (locale in listOf("values", "values-pt-rBR")) {
            val values = strings(locale)
            for (key in keys) assertFalse("$locale/$key", values[key].isNullOrBlank())
        }
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
