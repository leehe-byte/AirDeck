import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.opengw.manager"
    compileSdk = 33

    defaultConfig {
        applicationId = "com.opengw.manager"
        minSdk = 26
        targetSdk = 33
        versionCode = 39
        versionName = "4.0.1"
        // 编译产物命名为"应用名-版本-构建类型.apk"，如 OpenGW-4.0.1-release.apk
        setProperty("archivesBaseName", "${rootProject.name}-${versionName}")
    }

    // release 签名：keystore 由环境变量提供（GitHub Actions secrets 传入），本地无 env 时不签名
    signingConfigs {
        create("release") {
            val b64 = System.getenv("KEYSTORE_BASE64")
            if (!b64.isNullOrBlank()) {
                val keystoreFile = File.createTempFile("opengw_release", ".jks")
                // secrets 中的 base64 可能含换行/空白，先剔除再解码
                keystoreFile.writeBytes(Base64.getDecoder().decode(b64.filterNot { it.isWhitespace() }))
                storeFile = keystoreFile
                storePassword = System.getenv("KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("KEY_ALIAS") ?: ""
                keyPassword = System.getenv("KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        val hasReleaseKey = !System.getenv("KEYSTORE_BASE64").isNullOrBlank()
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKey) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.9.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    val ktor_version = "2.3.7"
    implementation("io.ktor:ktor-server-core:$ktor_version")
    implementation("io.ktor:ktor-server-cio:$ktor_version")
    implementation("io.ktor:ktor-server-call-logging:$ktor_version")
    implementation("io.ktor:ktor-server-websockets:$ktor_version")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
