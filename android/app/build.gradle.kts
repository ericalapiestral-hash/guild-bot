plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "kr.guildbot.overlay"
    compileSdk = 35

    defaultConfig {
        applicationId = "kr.guildbot.overlay"
        // TYPE_APPLICATION_OVERLAY(떠 있는 창)가 API 26부터라 그 아래는 애초에 못 돈다
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            // 사이드로딩용 — 서명 없이 바로 설치되는 디버그 APK가 기본 배포물이다
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }

    packaging {
        resources.excludes += "META-INF/*.version"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // 기기에 내장되는 인식 모델 — 인터넷 없이 동작한다 (tesseract 대체)
    implementation("com.google.mlkit:text-recognition:16.0.1")

    testImplementation("junit:junit:4.13.2")
    // 안드로이드의 org.json은 단위 테스트에서 껍데기라 진짜 구현을 따로 넣어 준다
    testImplementation("org.json:json:20240303")
}
