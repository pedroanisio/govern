package dev.supertools.govern.remote.ui

import android.app.Application
import org.junit.Assert.assertNotNull
import org.junit.Test

class AppModelContractTest {
    @Test fun defaultAndroidFactoryCanFindApplicationConstructor() {
        assertNotNull(AppModel::class.java.getConstructor(Application::class.java))
    }
}
