# MPSQ Team – Umstellung der Live-Kamerabilder auf Cloudflare R2

Dieses Update entfernt Live-PNGs vollständig aus Supabase Storage. Supabase
bleibt nur für Konten, Rechte, Kameras, Bildschirme und kurze, signierte R2-
Links zuständig. Die Bilddaten werden danach direkt zwischen Minecraft und R2
übertragen.

## 1. R2-Bucket

Der vorhandene Bucket muss exakt `mpsq-camera-frames` heißen. Der Token benötigt
nur für diesen Bucket die Rechte **Object Read & Write**.

## 2. Supabase Secrets

Im Supabase-Projekt unter **Edge Functions → Secrets** diese drei Werte
hinterlegen. Die Namen müssen exakt so geschrieben sein:

```text
R2_ACCOUNT_ID=<deine Cloudflare Account-ID>
R2_ACCESS_KEY_ID=<Access Key ID des R2-API-Tokens>
R2_SECRET_ACCESS_KEY=<Secret Access Key des R2-API-Tokens>
```

Optional kann `R2_BUCKET=mpsq-camera-frames` gesetzt werden. Ohne diesen Wert
verwendet die API automatisch genau diesen Bucket.

Die Schlüssel gehören ausschließlich in Supabase Secrets – niemals in GitHub,
die Website oder die Minecraft-Mod.

## 3. API veröffentlichen

Den vollständigen Inhalt von
`supabase/functions/mpsq-api/index.ts` in die Edge Function **mpsq-api**
übernehmen und **Deploy Updates** wählen.

## 4. Mod bauen und testen

Nach dem Ersetzen der Java-Dateien:

```powershell
.\gradlew.bat clean build
```

Die neue JAR in den Minecraft-`mods`-Ordner legen. Beim ersten Live-Bild wird
in R2 ein Objekt wie `frames/<kamera-uuid>.png` erscheinen. Pro Kamera bleibt
immer nur genau dieses eine Objekt erhalten und wird überschrieben.

## Erwartetes Ergebnis

- Keine Live-Bilddaten und keine Frame-Downloads mehr über Supabase Storage.
- Pro Quelle höchstens ein Supabase-Aufruf für einen neuen Upload-Link pro
  etwa 75 Sekunden.
- Pro Zuschauer höchstens ein Supabase-Aufruf für einen neuen Download-Link
  pro etwa 75 Sekunden.
- Die zehn eigentlichen Frame-Übertragungen pro Sekunde laufen direkt über
  Cloudflare R2.

Falls die Kamera nach dem Update offline bleibt, zuerst in Supabase prüfen, ob
alle drei Secrets vorhanden sind, anschließend die Edge Function erneut
deployen und erst dann die Mod erneut starten.
