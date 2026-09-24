# MPSQ 1.1 Beta – Bedienung

Minecraft 1.21.8, Java 21, Fabric API und MCEF bleiben erforderlich.

- Ränge: Icon anklicken, Beschreibung und Rechte bleiben geöffnet. „Mitglieder / Ränge“ führt zur bisherigen Verwaltung.
- Logs: dauerhafte Änderungen durch andere, mit Datum, Icons und zuständigem Moderator. Nur Offizier, Frontman und Sr Offizier.
- Texte: Bearbeiten und Kopieren mit &-Codes; Anzeige und Vorschau formatiert. Optional eine Sound-ID zuordnen. Die Aufnahme startet beim identischen gesendeten Chattext, nicht beim Kopieren.
- Eventaktionen: Musik-ID, durch Kommas getrennte Playlist, Ansage, Bossbar, Countdown oder Stop. Empfänger müssen Mod, passende Audioressourcen und dieselbe Server-/Dimensionskennung verwenden.
- Knöpfe: Block ansehen, `/mpsq-knopf`. Rechtsklick meldet die Aktion an Supabase. Das bestätigt keine Minecraft-Serveraktion.
- Objekte: Bodenblock ansehen, `/mpsq-objekt`. Modell-ID aus dem Admin-Upload verwenden; Objekt wird einen Block darüber angezeigt. Ersetzen, Drehen und Entfernen sind dort möglich. Die Modelle haben keine serverseitige Kollision.
- Zentrale Dateien: Im Admin-Panel liegen Möbel, Accessoires, Sounds/Musik und NPC-Skins als getrennte Bereiche. Jede Datei erhält eine stabile ID. Ein Modell wird entweder als Möbel oder als Accessoire eingetragen. Bei Möbeln bedeutet „interaktiv“ die vorgesehene spätere Verbindung mit einer Systemaktion; der eigentliche Knopf wird weiterhin im Spiel eingerichtet.
- Stand jetzt werden hochgeladene Sounddateien und NPC-Skins zentral gespeichert. Die aktuelle Wiedergabe nutzt weiterhin Sound-IDs aus einem installierten Ressourcenpaket; NPC-Skins werden erst mit dem späteren NPC-System im Spiel angezeigt. Möbel mit „interaktiv“ werden markiert, aber noch nicht automatisch mit einem Knopf verknüpft.
- Accessoires: Code einlösen, in „Accessoires“ anlegen/ablegen. Andere benötigen ebenfalls die MPSQ Mod.
- Kalender: Termine ansehen; Offizier und höher können Termine anlegen/entfernen. Anzeige in der lokalen Zeitzone.

## Modelle

Admin-Upload akzeptiert Java-Itemmodell-JSON mit separat ausgewählten PNGs und statische Blockbench-Dateien (.bbmodel) mit eingebetteten oder separat gelieferten PNGs.
Unterstützt: Würfelelemente, UV-Flächen, Elementrotationen. Nicht unterstützt: Meshes, Animationen, vererbte Parent-Geometrie, gedrehte Gruppen, rescale-Rotation. Diese Fälle müssen vor dem Import in Blockbench aufgelöst werden und werden sonst abgewiesen.
Maximal 512 Elemente, 32 Texturen, 1024×1024 je PNG und insgesamt 2.097.152 Texturpixel pro Modell. Das Modell wird für Kopfaccessoires um den Kopfanker platziert; Körper-/Handanimationen sind nicht angebunden.
Die Maße entsprechen Java-Modellen: 16 Einheiten = 1 Block. Eigene fertige Möbel-/Accessoiregrafiken und Audiodateien sind nicht im Paket enthalten.

## Prüfung

Build und automatisierte API-/Importprüfungen wurden ausgeführt. Mehrspielerbetrieb, Supabase-Migrationen und tatsächliche Darstellung müssen mit dem bereitgestellten Beta-Paket im Spiel geprüft werden. Die API und SQL wurden nicht automatisch veröffentlicht.
