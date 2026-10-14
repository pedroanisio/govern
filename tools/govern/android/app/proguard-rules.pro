# kotlinx.serialization: keep the generated serializers of the wire types.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class dev.supertools.govern.remote.protocol.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class dev.supertools.govern.remote.protocol.**$$serializer { *; }
