package dev.supertools.govern.remote.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

val FieldWarning = Color(0xFFF2B84B)
val FieldSuccess = Color(0xFF7BD88F)
val FieldCode = TextStyle(fontFamily = FontFamily.Monospace)

private val DarkField = darkColorScheme(
    background = Color(0xFF0B120E), surface = Color(0xFF121B15), surfaceVariant = Color(0xFF18241C),
    primary = Color(0xFFC6F432), onPrimary = Color(0xFF0B120E),
    onBackground = Color(0xFFE6EDE8), onSurface = Color(0xFFE6EDE8), onSurfaceVariant = Color(0xFF8A9A90),
    secondary = FieldSuccess, tertiary = FieldWarning, error = Color(0xFFFF6B5B),
)
private val LightField = lightColorScheme(
    background = Color(0xFFF4F2E9), surface = Color.White, surfaceVariant = Color(0xFFE6EDE8),
    primary = Color(0xFF1E3A2C), onPrimary = Color(0xFFD9F26A),
    surfaceContainerHighest = Color.White, primaryContainer = Color(0xFF1E3A2C), onPrimaryContainer = Color(0xFFD9F26A),
    secondaryContainer = Color(0xFFD9F26A), onSecondaryContainer = Color(0xFF17251D),
    secondary = Color(0xFFD9F26A), onSecondary = Color(0xFF0B120E),
    onBackground = Color(0xFF17251D), onSurface = Color(0xFF17251D), onSurfaceVariant = Color(0xFF6B776F),
    error = Color(0xFFC2410C),
)

@Composable
fun FieldTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkField else LightField,
        shapes = Shapes(medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(16.dp)), content = content)
}
