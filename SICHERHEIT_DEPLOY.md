# MPSQ Team – Rangschutz veröffentlichen

Dieses Paket ergänzt die bestehende Website um das geschützte Rang-Protokoll.

## 1. Datenbank aktualisieren

Öffne in Supabase den **SQL Editor** und führe den vollständigen Inhalt von
`supabase/MPSQ_TEAM.sql` aus. Die Datei darf mehrfach ausgeführt werden.

Dadurch entstehen das Rang-Antragsprotokoll, das unveränderbare Rang-Log und
die einmalige Sr-Offizier-Bindung. Alle Tabellen sind per RLS geschlossen;
nur die Edge Function kann sie lesen oder ändern.

## 2. Geheimnis kontrollieren

Unter **Edge Functions → Secrets** muss ein starkes, nur dir bekanntes
`ADMIN_PASSWORD` hinterlegt sein. Dieses Passwort wird auf der Admin-Seite
bei jeder Aktion abgefragt und ist nicht in GitHub gespeichert.

`SUPABASE_SERVICE_ROLE_KEY` muss ebenfalls weiter als Secret vorhanden sein.

## 3. API veröffentlichen

Ersetze in der Supabase Function **mpsq-api** den Inhalt von
`supabase/functions/mpsq-api/index.ts` und klicke auf **Deploy updates**.

Die Function akzeptiert Rangfreigaben ausschließlich über das Admin-Passwort.
Eine MPSQ-Team-Mod kann ab jetzt nur Rang-Anträge senden; sie kann keinen
hohen Rang direkt vergeben.

## 4. Website hochladen

Lade `admin.html` auf GitHub hoch und ersetze die vorhandene Datei. Danach
warte auf den erfolgreichen GitHub-Pages-Deploy.

Auf der Admin-Seite erscheint der Tab **Rang-Log**. Dort gibst du dein
Admin-Passwort ein, lädst Anträge und genehmigst oder lehnst sie ab.

## 5. MP_SquidGame einmalig sicher binden

1. Starte MPSQ Team mit dem echten Minecraft-Account **MP_SquidGame**.
2. Öffne danach die Admin-Seite → **Rang-Log**.
3. Klicke bei „Sr Offizier – einmalige Bindung“ auf **MP_SquidGame suchen**.
4. Prüfe den angezeigten Eintrag sorgfältig und klicke einmalig auf
   **Als Sr Offizier binden**.

Danach ist die Sr-Offizier-Identität an die interne, zufällige Client-ID
gebunden. Ihr sichtbarer Minecraft-Name allein reicht niemals aus, um diesen
Rang zu erhalten.

## 6. Mod-Patch

Die Datei unter `MPSQ-Team-Patch/src/client/java/.../MpsqApiClient.java`
gehört in die gleichnamige Datei deines MPSQ-Team-Projekts. Sie macht aus
jeder Rangänderung außer dem selbst verwalteten 001-Eventrang einen Antrag.

Anschließend die Mod neu bauen und die neue JAR verwenden.

## Sicherheitsgrenze

Die persönliche MPSQ-Zugangskennung wird zufällig erzeugt, lokal gespeichert
und auf dem Server nur als Hash hinterlegt. Eine manipulierte Mod kann damit
höchstens die Rechte ihres eigenen Kontos verwenden. Sie kann weder durch
einen gefälschten Namen noch durch einen veränderten Rangwert höhere Rechte
erhalten.
