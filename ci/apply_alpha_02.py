from pathlib import Path
import zlib

root = Path(__file__).resolve().parents[1]

capture_blob = root / "ci" / "CaptureActivity.kt.zlib"
capture_target = root / "app" / "src" / "main" / "java" / "ru" / "ipayev" / "chiefofstaff" / "CaptureActivity.kt"
capture_target.write_bytes(zlib.decompress(capture_blob.read_bytes()))

build = root / "app" / "build.gradle.kts"
text = build.read_text()
text = text.replace("versionCode = 1", "versionCode = 2")
text = text.replace('versionName = "0.1.0"', 'versionName = "0.2.0"')
build.write_text(text)

layout = root / "app" / "src" / "main" / "res" / "layout" / "widget_nikodim.xml"
text = layout.read_text()
text = text.replace('android:layout_width="38dp"', 'android:layout_width="48dp"')
text = text.replace('android:layout_height="38dp"', 'android:layout_height="48dp"')
text = text.replace('android:text="Нажать и диктовать"', 'android:text="Нажать → диктовать"')
layout.write_text(text)

info = root / "app" / "src" / "main" / "res" / "xml" / "nikodim_widget_info.xml"
text = info.read_text().replace('android:minHeight="64dp"', 'android:minHeight="72dp"')
info.write_text(text)

print("Applied Chief of Staff Android alpha 0.2 voice/widget patch")
