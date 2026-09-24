# Gemeinsame Client-Ereignisse

`/mpsq-knopf` registriert den angeschauten Block mit Serveradresse, Dimensionskennung, Koordinaten und Blocktyp. Der Client erkennt den Rechtsklick und meldet die Trigger-ID. Supabase prüft den gespeicherten Rang, die Kennungen und den Cooldown; danach holen andere Mod-Clients die Aktion ab.

Minecraft bestätigt diese Aktion nicht. Eine identische Serveradresse plus Dimension unterscheidet nicht automatisch mehrere Citybuild-Unterserver mit gleichen Koordinaten. Unterschiedliche Serveradressen gelten als getrennte Bereiche; Aliasadressen werden nicht automatisch zusammengeführt.

Aktionen: PLAY_AUDIO, START_PLAYLIST (tracks als Sound-ID-Liste), STOP_AUDIO, SHOW_BOSSBAR, START_COUNTDOWN, HIDE_BOSSBAR, SEND_ANNOUNCEMENT, OPEN_REDEEM, OPEN_LINK. Die letzten beiden Aktionen öffnen nur beim auslösenden Client ein Fenster. Audio muss bereits als Sound im Mod-/Ressourcenpaket existieren.

Neue Clients starten am aktuellen Ereigniscursor. Vergangene Ereignisse werden beim Join nicht erneut abgespielt; bereits laufende Musik und Countdowns werden noch nicht nachträglich synchronisiert.
