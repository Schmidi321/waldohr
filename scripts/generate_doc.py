#!/usr/bin/env python3
"""Erzeugt docs/WaldOhr-Anleitung.pdf aus dem Inhalt unten.

Screenshots: erwartet PNG/JPG-Dateien in docs/assets/ mit den Namen, die im
SCREENS-Dict je Abschnitt hinterlegt sind. Fehlt eine Datei, wird ein
Platzhalter-Rahmen mit Bildunterschrift gedruckt statt eines echten Bilds --
einfach die Datei später unter dem passenden Namen ablegen und das Skript
erneut laufen lassen (kein Codeaenderung noetig).

Aufruf:  python scripts/generate_doc.py
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image, Table, TableStyle,
    ListFlowable, ListItem, HRFlowable, KeepTogether, Flowable
)
from reportlab.pdfgen import canvas as pdfcanvas

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(BASE, 'docs', 'assets')
OUT = os.path.join(BASE, 'docs', 'WaldOhr-Anleitung.pdf')

LIME = colors.HexColor('#7fa832')
DARK = colors.HexColor('#123524')
MUTED = colors.HexColor('#5a6b60')
FAINT = colors.HexColor('#8a9a8f')
STROKE = colors.HexColor('#c9d6cc')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle('WOTitle', parent=styles['Title'], fontSize=30, textColor=DARK, spaceAfter=6))
styles.add(ParagraphStyle('WOSubtitle', parent=styles['Normal'], fontSize=13, textColor=MUTED, alignment=TA_CENTER, spaceAfter=4))
styles.add(ParagraphStyle('WOH1', parent=styles['Heading1'], fontSize=19, textColor=DARK, spaceBefore=4, spaceAfter=10,
                          borderPadding=0, borderColor=LIME, borderWidth=0))
styles.add(ParagraphStyle('WOH2', parent=styles['Heading2'], fontSize=14, textColor=DARK, spaceBefore=14, spaceAfter=6))
styles.add(ParagraphStyle('WOBody', parent=styles['Normal'], fontSize=10.3, leading=15, textColor=colors.HexColor('#1c2b22'), spaceAfter=8))
styles.add(ParagraphStyle('WOBullet', parent=styles['WOBody'], leftIndent=0, spaceAfter=4))
styles.add(ParagraphStyle('WOCaption', parent=styles['Normal'], fontSize=8.5, textColor=FAINT, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10))
styles.add(ParagraphStyle('WONote', parent=styles['WOBody'], backColor=colors.HexColor('#eef5ec'), borderColor=LIME,
                          borderWidth=0.6, borderPadding=8, spaceAfter=10))
styles.add(ParagraphStyle('WOTocEntry', parent=styles['Normal'], fontSize=11, textColor=DARK, spaceAfter=5, leftIndent=8))
styles.add(ParagraphStyle('WOTocSection', parent=styles['Normal'], fontSize=11, textColor=DARK, spaceBefore=8, spaceAfter=3, fontName='Helvetica-Bold'))


def h1(text):
    return [HRFlowable(width='100%', thickness=1.4, color=LIME, spaceAfter=8), Paragraph(text, styles['WOH1'])]


def h2(text):
    return Paragraph(text, styles['WOH2'])


def p(text):
    return Paragraph(text, styles['WOBody'])


def note(text):
    return Paragraph('💡 ' + text, styles['WONote'])


def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(it, styles['WOBullet']), leftIndent=14, bulletColor=LIME) for it in items],
        bulletType='bullet', start='circle', spaceAfter=8,
    )


class PlaceholderBox(Flowable):
    """Gestrichelter Platzhalter-Rahmen fuer noch fehlende Screenshots."""
    def __init__(self, width, height, label):
        super().__init__()
        self.width = width
        self.height = height
        self.label = label

    def draw(self):
        c = self.canv
        c.saveState()
        c.setDash(4, 3)
        c.setStrokeColor(STROKE)
        c.setLineWidth(1)
        c.setFillColor(colors.HexColor('#f4f7f4'))
        c.roundRect(0, 0, self.width, self.height, 6, stroke=1, fill=1)
        c.setFillColor(FAINT)
        c.setFont('Helvetica', 9)
        c.drawCentredString(self.width / 2, self.height / 2 + 6, '📷 Screenshot folgt')
        c.setFont('Helvetica-Oblique', 8)
        c.drawCentredString(self.width / 2, self.height / 2 - 8, self.label)
        c.restoreState()


def screenshot(filename, caption, max_width=140 * mm, max_height=90 * mm):
    """Bild einfuegen, wenn docs/assets/<filename> existiert -- sonst Platzhalter."""
    path = os.path.join(ASSETS, filename)
    flow = []
    if os.path.isfile(path):
        img = Image(path)
        iw, ih = img.imageWidth, img.imageHeight
        scale = min(max_width / iw, max_height / ih, 1.0)
        img.drawWidth = iw * scale
        img.drawHeight = ih * scale
        img.hAlign = 'CENTER'
        flow.append(img)
    else:
        flow.append(PlaceholderBox(max_width, max_height * 0.55, filename))
    flow.append(Paragraph(caption, styles['WOCaption']))
    return KeepTogether(flow)


# ---------------------------------------------------------------------------
# Inhalt
# ---------------------------------------------------------------------------
story = []

# ---- Titelseite ----
story.append(Spacer(1, 60 * mm))
story.append(Paragraph('🌲 WaldOhr', styles['WOTitle']))
story.append(Paragraph('Tierstimmen erkennen — Benutzerhandbuch', ParagraphStyle(
    'sub2', parent=styles['WOSubtitle'], fontSize=15, textColor=DARK)))
story.append(Spacer(1, 6 * mm))
story.append(Paragraph(
    'Dein Smartphone wird zum Fernglas fürs Ohr: Vogel- und Tierstimmen erkennen, verorten, '
    'sammeln und mit anderen teilen — offline, ohne Anmeldung.', styles['WOSubtitle']))
story.append(Spacer(1, 40 * mm))
story.append(Paragraph('Ausführliche Anleitung · Alle Funktionen im Überblick', ParagraphStyle(
    'sub3', parent=styles['WOSubtitle'], fontSize=10, textColor=FAINT)))
story.append(PageBreak())

# ---- Inhaltsverzeichnis (manuell, ohne Seitenzahlen) ----
story += h1('Inhalt')
toc = [
    ('1. Einleitung', ['Was ist WaldOhr?', 'Grundprinzip: offline, ohne Server, ohne Anmeldung']),
    ('2. Erste Schritte', ['Start & Berechtigungen', 'Die fünf Hauptbereiche im Überblick']),
    ('3. Lauschen — Live-Erkennung', ['Der Lausch-Modus', 'Spektrogramm & Pegelanzeige', 'Manuelle Aufnahme', 'Live-Fundliste']),
    ('4. Erkennungsmodi', ['Demo-Modus', 'BirdNET On-Device', 'BirdNET-Server', 'Verbindungsstatus-Symbol', 'Mikrofonwahl']),
    ('5. Fundkarte', ['Karte & Marker', 'Eigene Position & Kompass', 'Route aufzeichnen']),
    ('6. Sammlung', ['Heute hier', 'Global nach Ort']),
    ('7. Statistik', ['Kennzahlen & Diagramme', 'Export (eBird, Ornitho)']),
    ('8. Ornithologie', ['Punkt-Zählung', 'Transekt-Zählung', 'Protokolle', 'Wissenschaftlicher Export']),
    ('9. Fund-Details', ['Ruf-Bedeutung', 'Steckbrief', 'Foto-Tipp', 'Richtung zum letzten Fund']),
    ('10. Kamera', ['Foto & Video', 'Auto-Zoom', 'Zeitraffer & Serienaufnahme', 'Dual-Kamera']),
    ('11. Timing, Alarm & Wetter', ['Morgenchor', 'Nacht-Modus', 'Fotografen-Wecker', 'Dauerüberwachung', 'Foto-Wetter']),
    ('12. Aufnahmen & Fotos', ['Galerie', 'Teilen & Reels']),
    ('13. Partner koppeln', ['Zwei Handys koppeln', 'Chat & Sprachnachrichten', 'Gemeinsame Ruf-Ortung',
                              'Gemeinsamer Bericht', 'Foto/Video-Versand', 'Stern-Modell (3+ Geräte)']),
    ('14. Einstellungen', ['Alle Optionen im Detail']),
    ('15. Beobachtungsliste', ['Favoriten verwalten']),
    ('16. Datenschutz & Offline-Fähigkeit', []),
    ('17. Bekannte Einschränkungen', ['BirdNET-Lizenz', 'On-Device-Grenzen', 'Kopplung im selben Netz']),
]
for section, subs in toc:
    story.append(Paragraph(section, styles['WOTocSection']))
    for s in subs:
        story.append(Paragraph('· ' + s, styles['WOTocEntry']))
story.append(PageBreak())

# ---- 1. Einleitung ----
story += h1('1. Einleitung')
story.append(p(
    'WaldOhr ist eine mobile Web-App (PWA), die Tierlaute — vor allem Vogelrufe — anhand des '
    'Mikrofons erkennt, auf einer Karte verortet, sammelt und auswertet. Sie richtet sich an '
    'Naturbeobachter:innen, Hobby-Ornitholog:innen und alle, die auf einem Spaziergang wissen '
    'wollen, wer da gerade singt.'))
story.append(p(
    'Die App läuft komplett im Browser (bzw. als installierte PWA) und legt großen Wert auf '
    '<b>Offline-Fähigkeit</b>: alle Funde werden lokal auf dem Gerät gespeichert (IndexedDB), es '
    'gibt keine Registrierung, kein Konto und standardmäßig keine Cloud-Anbindung. Optionale '
    'Online-Funktionen (Gemini-KI-Anreicherung, echte BirdNET-Server-Erkennung, echte '
    'Vogelrufe von Xeno-canto) lassen sich einzeln in den Einstellungen aktivieren.'))
story.append(screenshot('01-splash.png', 'Startbildschirm mit Kurzvorstellung der App'))
story.append(note(
    'Ein zweites Highlight der App: zwei (oder mehr) Handys lassen sich direkt miteinander '
    'koppeln — per QR-Code, ganz ohne eigenen Server — um gemeinsam zu chatten, Rufe zu orten '
    'und Fotos auszutauschen. Siehe Kapitel 13.'))

story += [h2('Grundprinzip: offline, ohne Server, ohne Anmeldung')]
story.append(bullets([
    '<b>Keine Anmeldung</b> — die App ist sofort nutzbar, es gibt keinen Account.',
    '<b>Lokale Speicherung</b> — alle Funde, Aufnahmen und Fotos bleiben auf dem Gerät (IndexedDB), '
    'nichts wird automatisch irgendwohin hochgeladen.',
    '<b>Offline installierbar</b> — als Progressive Web App (PWA) mit Service Worker: einmal geladen, '
    'läuft die App-Oberfläche auch ohne Internetverbindung.',
    '<b>Optionale Online-Funktionen</b> — wer möchte, kann in den Einstellungen einen eigenen '
    'Gemini-API-Schlüssel hinterlegen (KI-Erklärungen zu Rufen) oder einen BirdNET-Server angeben '
    '(echte, serverseitige Erkennung statt Demo-Modus). Beides ist rein optional.',
]))
story.append(PageBreak())

# ---- 2. Erste Schritte ----
story += h1('2. Erste Schritte')
story.append(p(
    'Beim ersten Start zeigt WaldOhr einen kurzen Begrüßungsbildschirm mit den wichtigsten '
    'Funktionen. Ein Tipp auf „Weiter" führt direkt in den Hauptbereich „Lauschen".'))
story.append(p(
    'Für die volle Funktionalität fragt die App nach drei Berechtigungen, jeweils erst dann, '
    'wenn die zugehörige Funktion tatsächlich gebraucht wird:'))
story.append(bullets([
    '<b>Mikrofon</b> — für die Ruferkennung (Kapitel 3) und Sprachnachrichten (Kapitel 13).',
    '<b>Standort (GPS)</b> — um Funde auf der Karte zu verorten, Routen aufzuzeichnen und '
    'Sonnenaufgang/-untergang für die Alarme zu berechnen.',
    '<b>Kamera</b> — für Belegfotos, Videos und das Scannen von QR-Codes beim Koppeln.',
]))
story.append(note(
    'Keine dieser Berechtigungen ist zwingend — die App funktioniert auch eingeschränkt ohne sie '
    '(z. B. Erkennung ohne Standort, dann eben ohne Karten-Verortung).'))

story += [h2('Die fünf Hauptbereiche im Überblick')]
story.append(p('Über die Navigationsleiste am unteren Bildschirmrand wechselst du zwischen fünf Tabs:'))
story.append(bullets([
    '<b>Lauschen</b> — Live-Mikrofon, Ruferkennung, Aufnahme (Startbildschirm der App).',
    '<b>Karte</b> — alle verorteten Funde auf einer Karte, plus GPS-Routenaufzeichnung.',
    '<b>Sammlung</b> — Übersicht der eigenen Funde, heute und insgesamt.',
    '<b>Statistik</b> — Auswertungen, Diagramme, Export für eBird/Ornitho.',
    '<b>Ornithologie</b> — strukturierte Zählmethoden (Punkt-/Transekt-Zählung), Protokolle, '
    'wissenschaftlicher Export.',
]))
story.append(screenshot('02-navigation.png', 'Die Navigationsleiste mit den fünf Hauptbereichen'))
story.append(PageBreak())

# ---- 3. Lauschen ----
story += h1('3. Lauschen — Live-Erkennung')
story.append(p(
    'Der Bereich „Lauschen" ist die Startseite der App und ihr Herzstück. Ein Tipp auf den großen '
    'runden Orb-Button startet das Mikrofon: WaldOhr hört fortlaufend mit und vergleicht kurze '
    'Zeitfenster (3 Sekunden) gegen die aktive Erkennungs-Engine (siehe Kapitel 4).'))
story.append(screenshot('03-lauschen.png', 'Der Lausch-Modus mit aktivem Mikrofon'))
story += [h2('Spektrogramm & Pegelanzeige')]
story.append(p(
    'Während des Lauschens zeigt ein laufendes Spektrogramm die Frequenzverteilung des '
    'Umgebungsklangs in Echtzeit — hilfreich, um zu sehen, ob überhaupt ein Ruf ankommt, bevor '
    'eine Erkennung feststeht. Eine Pegelanzeige darunter zeigt die reine Lautstärke.'))
story += [h2('Manuelle Aufnahme')]
story.append(p(
    'Der kleine REC-Knopf in der Mitte des Orbs startet eine manuelle Tonaufnahme — nützlich, um '
    'einen interessanten Ruf unabhängig von der automatischen Erkennung festzuhalten und später '
    'in der Galerie (Kapitel 12) anzuhören oder zu teilen.'))
story += [h2('Live-Fundliste')]
story.append(p(
    'Unterhalb der Anzeige läuft eine Liste „Jetzt zu hören" mit, die jede erkannte Art sofort '
    'nach dem Treffer einblendet — inklusive Konfidenzwert. Ein Tipp auf einen Eintrag öffnet die '
    'ausführliche Fund-Detailansicht (Kapitel 9).'))
story.append(p(
    'Über die Icons neben der Fundliste erreichst du außerdem direkt: Timing/Alarm-Einstellungen, '
    'Foto-Wetter-Infos (aktuelle Lichtverhältnisse) und die Galerie aller Aufnahmen/Fotos.'))
story.append(PageBreak())

# ---- 4. Erkennungsmodi ----
story += h1('4. Erkennungsmodi')
story.append(p(
    'WaldOhr kann Rufe auf drei unterschiedliche Arten klassifizieren. Welcher Modus aktiv ist, '
    'wird beim Start automatisch anhand der Einstellungen gewählt.'))
story += [h2('Demo-Modus (Mock)')]
story.append(p(
    'Ohne weitere Einrichtung läuft die App im Demo-Modus: plausible, aber zufällig gewählte '
    'Treffer aus einem festen Arten-Pool. Gedacht zum Ausprobieren der Bedienung, ohne dass eine '
    'echte Erkennung im Hintergrund läuft.'))
story += [h2('BirdNET On-Device')]
story.append(p(
    'Liegt ein BirdNET-TensorFlow.js-Modell im App-Verzeichnis, versucht WaldOhr, es direkt im '
    'Browser auszuführen. <b>Wichtige Einschränkung:</b> Das offizielle BirdNET-Modell (Version 2.4) '
    'nutzt spezielle Audio-Vorverarbeitungsschritte (STFT/RFFT), die die im Browser verfügbare '
    'TensorFlow.js/WASM-Laufzeit nicht ausführen kann. In der Praxis fällt die App deshalb meist '
    'automatisch auf den Demo-Modus zurück. Echte Erkennung braucht aktuell den Server-Modus.'))
story += [h2('BirdNET-Server')]
story.append(p(
    'Für echte BirdNET-Erkennung kann in den Einstellungen die Adresse eines selbst betriebenen '
    'BirdNET-Servers hinterlegt werden (Python-Backend, im Projekt unter <font face="Courier">server/'
    '</font> enthalten). Die App schickt dann jedes 3-Sekunden-Fenster als WAV-Datei an den Server '
    'und bekommt die Klassifizierung zurück — inklusive Standort- und Jahreszeit-Gewichtung, wenn '
    'GPS verfügbar ist.'))
story += [h2('Verbindungsstatus-Symbol')]
story.append(p(
    'Im Server-Modus zeigt ein kleines Symbol oben in der Kopfzeile den Verbindungsstatus: '
    '<font color="#7fa832">grün</font> = verbunden, <font color="#c99a1f">gelb, pulsierend</font> = '
    'verbindet gerade, <font color="#c0392b">rot, pulsierend</font> = Server nicht erreichbar. '
    'Das Symbol wird bei jedem Erkennungsversuch neu geprüft, damit ein Verbindungsabbruch '
    '(schlechter Empfang, Server neugestartet) sofort auffällt — statt nur daran erkennbar zu sein, '
    'dass plötzlich keine Funde mehr kommen.'))
story.append(screenshot('04-server-status.png', 'Verbindungsstatus-Symbol neben der Standortanzeige'))
story += [h2('Mikrofonwahl')]
story.append(p(
    'In den Einstellungen lässt sich ein externes Mikrofon auswählen, falls mehrere '
    'Audioeingabegeräte am Handy angeschlossen sind (z. B. ein Richtmikrofon für bessere Reichweite).'))
story.append(PageBreak())

# ---- 5. Fundkarte ----
story += h1('5. Fundkarte')
story.append(p(
    'Die Karte zeigt alle verorteten Funde als farbige Punkte — Grün für häufige Arten, Gelb für '
    'seltene, Rot für Säugetiere, Hellgrün für Arten aus der eigenen Beobachtungsliste. Ein Tipp '
    'auf einen Punkt zeigt Artname und Icon in einer kleinen Sprechblase; ein weiterer Tipp öffnet '
    'die volle Detailansicht.'))
story.append(screenshot('05-karte.png', 'Fundkarte mit verorteten Beobachtungen'))
story += [h2('Eigene Position & Kompass')]
story.append(p(
    'Ist GPS aktiv, zeigt ein kleines Männchen-Symbol die aktuelle eigene Position auf der Karte, '
    'inklusive Bewegungsrichtung (dreht sich, sobald sich die Position ändert). Ist außerdem ein '
    'Partner-Handy gekoppelt (Kapitel 13), erscheint dessen Position als eigener, nummerierter '
    'Marker — ein Tipp darauf zeigt Entfernung und Himmelsrichtung zu genau dieser Person.'))
story += [h2('Route aufzeichnen')]
story.append(p(
    'Der Routen-Knopf in der Kartenansicht startet/stoppt eine GPS-Streckenaufzeichnung, '
    'unabhängig vom Mikrofon — man kann also eine Route aufzeichnen, ohne gleichzeitig zu '
    'lauschen, und umgekehrt normal lauschen, ohne dass automatisch eine Route mitläuft. '
    'Alle 15 Sekunden wird ein GPS-Punkt gesetzt. Am Ende lässt sich die Strecke als GPX-Datei '
    'exportieren (z. B. für andere Wander-Apps).'))
story.append(note(
    'Die Transekt-Zählung im Ornithologie-Bereich (Kapitel 8) nutzt denselben Aufzeichnungs-'
    'Mechanismus, allerdings mit einem dichteren 10-Sekunden-Takt für eine genauere Strecke. '
    'Beide Aufzeichnungen schließen sich gegenseitig aus — läuft eine, lässt sich die andere '
    'erst starten, nachdem die erste beendet wurde.'))
story.append(PageBreak())

# ---- 6. Sammlung ----
story += h1('6. Sammlung')
story.append(p(
    'Die Sammlung listet alle eigenen Funde in zwei Ansichten:'))
story.append(bullets([
    '<b>Heute hier</b> — alle Funde des heutigen Tages am aktuellen Standort, mit Statistik-Kacheln '
    'oben (Anzahl Arten, Gesamtfunde, seltenste Art, …).',
    '<b>Global nach Ort</b> — die komplette Fund-Historie, gruppiert nach Fundort, unabhängig vom '
    'Zeitpunkt.',
]))
story.append(screenshot('06-sammlung.png', 'Sammlung mit heutigen Funden am Standort'))
story.append(PageBreak())

# ---- 7. Statistik ----
story += h1('7. Statistik')
story.append(p(
    'Die Statistik-Seite wertet die gesammelten Funde grafisch aus: Kennzahlen '
    '(Gesamtzahl, Artenvielfalt, …), die häufigsten Arten nach Rufanzahl, ein Balkendiagramm der '
    'letzten 14 Tage sowie ein Tagesverlauf, der typischerweise den „Morgenchor" als Aktivitätsspitze '
    'zeigt.'))
story.append(screenshot('07-statistik.png', 'Statistik-Ansicht mit Diagrammen'))
story += [h2('Export (eBird, Ornitho)')]
story.append(p(
    'Über den Export-Tab lassen sich alle qualifizierenden Funde (≥ 70 % Konfidenz) inklusive GPS-'
    'Koordinaten, Uhrzeit und Wetterdaten als CSV exportieren — wahlweise im eBird-Checklisten-'
    'Format (Cornell Lab) oder im Ornitho.de-Beobachtungsformat.'))
story.append(PageBreak())

# ---- 8. Ornithologie ----
story += h1('8. Ornithologie')
story.append(p(
    'Der Ornithologie-Bereich bietet strukturierte, wissenschaftlich anerkannte Zählmethoden für '
    'systematische Kartierungen — über die freie Live-Erkennung hinaus.'))
story += [h2('Punkt-Zählung')]
story.append(p(
    'Eine 5-Minuten-Zählung nach BirdLife-Standard: von einem festen Standort aus werden alle in '
    'diesem Zeitraum erkannten Rufe automatisch erfasst. Ein Timer zählt die verbleibende Zeit '
    'herunter.'))
story += [h2('Transekt-Zählung')]
story.append(p(
    'Für eine feste Strecke, die abgegangen wird: GPS zeichnet die Route auf (10-Sekunden-Takt, '
    'siehe Kapitel 5), das Mikrofon lauscht durchgehend, die Dauer ist frei — die Zählung wird '
    'manuell am Ziel beendet. Am Ende zeigt die App eine Zusammenfassung mit zurückgelegter '
    'Strecke und erkannten Arten.'))
story.append(screenshot('08-ornithologie.png', 'Ornithologie-Bereich mit Punkt- und Transekt-Zählung'))
story += [h2('Protokolle')]
story.append(p(
    'Alle abgeschlossenen Punkt- und Transekt-Zählungen werden als Protokoll gespeichert und '
    'lassen sich hier jederzeit nachträglich einsehen — inklusive Artenliste und Route.'))
story += [h2('Wissenschaftlicher Export')]
story.append(p(
    'Zusätzlich zu eBird- und Ornitho-CSV stehen hier zwei weitere Formate bereit: eine '
    '<b>BirdNET-Notebook-CSV</b> mit Einzelfunden und Konfidenzwerten (kompatibel zum offiziellen '
    'BirdNET-Analyzer) sowie ein <b>NABU/Naturgucker-JSON</b> für strukturierten Import in '
    'entsprechende Portale.'))
story.append(PageBreak())

# ---- 9. Fund-Details ----
story += h1('9. Fund-Details')
story.append(p(
    'Ein Tipp auf einen Fund — egal ob in der Live-Liste, der Sammlung oder auf der Karte — öffnet '
    'die ausführliche Detailansicht mit mehreren Abschnitten:'))
story.append(bullets([
    '<b>Was bedeutet der Ruf?</b> — Erklärung der Rufbedeutung (Reviergesang, Warnruf, …), '
    'optional per Gemini-KI angereichert, wenn ein eigener API-Schlüssel hinterlegt ist.',
    '<b>Steckbrief</b> — kurze Artbeschreibung (Größe, Lebensraum, Häufigkeit).',
    '<b>Foto-Tipp für diese Art</b> — praktische Hinweise fürs Fotografieren dieser Art, ebenfalls '
    'optional per Gemini angereichert.',
    '<b>Letzter Fund</b> — Zeitpunkt und Ort des letzten Nachweises dieser Art.',
    '<b>Richtung zum letzten Fund</b> — ein Kompass, der (mit Gerätekompass-Freigabe) in echter '
    'Zeit die Richtung zum letzten Fundort dieser Art anzeigt.',
]))
story.append(screenshot('09-fund-detail.png', 'Fund-Detailansicht mit Steckbrief und Kompass'))
story.append(PageBreak())

# ---- 10. Kamera ----
story += h1('10. Kamera')
story.append(p(
    'Über die Galerie lässt sich direkt ein Foto oder Video zu einem Fund aufnehmen — die '
    'App bringt dafür eine eigene Kamera-Oberfläche mit (kein Umweg über die System-Kamera-App '
    'nötig, außer als Rückfalloption).'))
story += [h2('Auto-Zoom')]
story.append(p(
    'Ein automatischer, langsamer Zoom kann während einer Videoaufnahme das Bild kontinuierlich '
    'heran- oder wegzoomen, für einen filmischen Effekt — Geschwindigkeit (schnell/langsam) und '
    'Richtung (rein/raus) sind einstellbar. Auf Geräten mit mehreren Kameraobjektiven '
    '(Ultra-Weit/Normal/Tele) lässt sich beim Scannen von QR-Codes zusätzlich das Objektiv wählen, '
    'falls die Standardkamera aus der Nähe schlecht fokussiert.'))
story += [h2('Zeitraffer & Serienaufnahme')]
story.append(p(
    'Ein Zeitraffer-Modus nimmt über einen längeren Zeitraum in festen Abständen Einzelbilder auf '
    'und setzt sie zu einem kurzen Video zusammen. Die Serienaufnahme löst mehrere Fotos in '
    'schneller Folge aus (z. B. für einen Vogel im Flug).'))
story += [h2('Dual-Kamera')]
story.append(p(
    'Auf unterstützten Geräten kann WaldOhr Vorder- und Rückkamera gleichzeitig nutzen — etwa für '
    'ein „Ich war dabei"-Bild-in-Bild neben dem eigentlichen Naturfoto.'))
story.append(PageBreak())

# ---- 11. Timing, Alarm & Wetter ----
story += h1('11. Timing, Alarm & Wetter')
story.append(p(
    'Über das Uhr-Symbol neben der Live-Fundliste öffnet sich ein Modal mit vier zeitgesteuerten '
    'Funktionen sowie aktuellen Licht-/Wetterinformationen:'))
story += [h2('Morgenchor')]
story.append(p(
    'Startet das Lauschen automatisch kurz vor Sonnenaufgang — wenn die Vögel am lautesten singen. '
    'Der Vorlauf (Minuten vor Sonnenaufgang) ist einstellbar. Benötigt GPS und eine geöffnete App.'))
story += [h2('Nacht-Modus')]
story.append(p(
    'Startet und beendet das Lauschen zu festen Uhrzeiten — gedacht für Nachteulen, Fledermäuse '
    'oder andere nachtaktive Arten.'))
story += [h2('Fotografen-Wecker')]
story.append(p(
    'Weckt rechtzeitig fürs Sonnenaufgangs-Shooting. Ein Tipp auf die Sonnengrafik zeigt die '
    'genauen fotografischen Dämmerungsphasen (blaue Stunde, goldene Stunde, …) für den aktuellen '
    'Standort und Tag.'))
story += [h2('Dauerüberwachung')]
story.append(p(
    'Begrenzt eine Lauschsitzung automatisch auf eine festgelegte Dauer — praktisch, um das Handy '
    'für eine Weile unbeaufsichtigt lauschen zu lassen, ohne dass Mikrofon und Akku unbegrenzt '
    'weiterlaufen.'))
story += [h2('Foto-Wetter')]
story.append(p(
    'Zeigt aktuelle Licht- und Wetterbedingungen für Fotograf:innen: Bewölkung, Windrichtung, '
    'nächste Dämmerungsphasen und eine kurze Einschätzung, wie günstig das Licht gerade ist.'))
story.append(PageBreak())

# ---- 12. Galerie ----
story += h1('12. Aufnahmen & Fotos')
story.append(p(
    'Die Galerie sammelt alle manuell aufgenommenen Tonclips, Fotos und Videos an einem Ort. Jede '
    'Aufnahme lässt sich abspielen, herunterladen, teilen oder löschen.'))
story.append(screenshot('10-galerie.png', 'Galerie mit Aufnahmen und Fotos'))
story += [h2('Teilen & Reels')]
story.append(p(
    'Fotos lassen sich direkt als hübsch gestaltete „Fund-Karte" teilen (Art, Ort, Datum als '
    'Overlay). Aus Foto + zugehöriger Tonaufnahme lässt sich außerdem ein kurzes Reel-Video '
    'erstellen, ideal zum Teilen in sozialen Netzwerken.'))
story.append(PageBreak())

# ---- 13. Partner koppeln ----
story += h1('13. Partner koppeln')
story.append(p(
    'Eine der besonderen Funktionen von WaldOhr: zwei oder mehr Handys lassen sich direkt '
    'miteinander verbinden — ganz ohne eigenen Server, ganz ohne Internet-Konto. Die Verbindung '
    'läuft über WebRTC (Peer-to-Peer, verschlüsselt), aufgebaut per QR-Code-Austausch. Beide '
    'Geräte müssen sich dafür im selben lokalen Netz befinden (gleiches WLAN oder ein gemeinsamer '
    'Hotspot) — siehe dazu auch Kapitel 17.'))
story.append(screenshot('11-pairing.png', 'Kopplungs-Fenster mit QR-Code'))
story += [h2('Zwei Handys koppeln')]
story.append(p(
    'Ein Handy zeigt einen QR-Code („Angebot"), das andere scannt ihn und zeigt seinerseits einen '
    'Antwort-Code, den das erste Handy zurückscannt. Danach steht die Verbindung — ganz ohne '
    'weitere Schritte.'))
story += [h2('Chat & Sprachnachrichten')]
story.append(p(
    'Über den Datenkanal lassen sich Kurznachrichten austauschen. Ein Walkie-Talkie-artiger '
    'Sprachnachrichten-Knopf (halten zum Aufnehmen, loslassen zum Senden) ergänzt den reinen '
    'Text-Chat.'))
story += [h2('Gemeinsame Ruf-Ortung')]
story.append(p(
    'Hören beide Handys denselben Ruf im selben Zeitfenster, berechnet WaldOhr aus dem '
    'Zeitversatz und den GPS-Positionen beider Geräte eine grobe Einschätzung, welches Gerät '
    'näher an der Quelle war. Bewusst <b>keine</b> falsch-präzise Pfeilrichtung: mit nur zwei '
    'Empfängern lässt sich physikalisch keine eindeutige Peilung berechnen, nur die Aussage '
    '„eher näher an dir" oder „eher näher am Partner".'))
story += [h2('Gemeinsamer Session-Bericht')]
story.append(p(
    'Am Ende eines gemeinsamen Spaziergangs lässt sich per Knopfdruck ein zusammengeführter '
    'Bericht erstellen: alle Funde beider (oder aller) gekoppelten Geräte seit Beginn der Kopplung, '
    'zusammengefasst nach Art.'))
story += [h2('Foto/Video-Versand')]
story.append(p(
    'Fotos und Videos aus der Galerie lassen sich direkt und komplett offline ans gekoppelte '
    'Partner-Handy (oder — im Stern-Modell — an alle gekoppelten Handys gleichzeitig) senden.'))
story += [h2('Stern-Modell (3+ Geräte)')]
story.append(p(
    'Mehr als zwei Handys lassen sich ebenfalls koppeln: das erste Gerät wird automatisch zur '
    '„Zentrale", sobald ein drittes Handy hinzukommt, und leitet Nachrichten zwischen allen '
    'Speichen weiter — Chat, Positionen und Funde werden dadurch mit der ganzen Gruppe geteilt, '
    'nicht nur paarweise. Wer die Zentrale ist und welche Nummer man selbst hat, wird in der '
    'Kopplungs-Ansicht klar angezeigt. Auf der Karte bekommt jeder gekoppelte Partner einen '
    'nummerierten Marker; ein Tipp darauf zeigt Entfernung und Richtung zu genau dieser Person.'))
story.append(PageBreak())

# ---- 14. Einstellungen ----
story += h1('14. Einstellungen')
story.append(p('Über das Zahnrad-Symbol erreichbar. Enthält unter anderem:'))
story.append(bullets([
    '<b>Mikrofon</b> — externes Mikrofon auswählen, falls mehrere Audiogeräte verfügbar sind.',
    '<b>Gemini-Anreicherung</b> — eigener API-Schlüssel für KI-erklärte Rufbedeutungen und Foto-Tipps.',
    '<b>Echte Vogelrufe (Xeno-canto)</b> — Originalaufnahmen der jeweiligen Art zum Vergleich abspielen.',
    '<b>Echte Erkennung (BirdNET-Server)</b> — Adresse eines selbst betriebenen BirdNET-Servers hinterlegen.',
    '<b>Empfindlichkeit</b> — wie sicher (Konfidenz) eine Erkennung mindestens sein muss, um als Fund zu zählen.',
    '<b>Display an lassen</b> — verhindert, dass der Bildschirm während des Lauschens abschaltet.',
    '<b>Kamera-Klick</b> — Auslösegeräusch beim Fotografieren ein-/ausschalten.',
    '<b>Kamera-Bedienung</b> — Hinweise/Tipps zur Kamera-Oberfläche.',
    '<b>Tipps für Fotografen</b> — kurzer Leitfaden für gute Naturfotos.',
    '<b>Sicherung</b> — vollständige Datensicherung (alle Funde, Aufnahmen, Fotos) exportieren und '
    'auf einem anderen Gerät wiederherstellen.',
    '<b>Datenbank zurücksetzen</b> — alle gespeicherten Daten unwiderruflich löschen.',
    '<b>Über &amp; Danksagungen</b> — Hinweise zu verwendeten Diensten und Lizenzen (u. a. BirdNET/Cornell).',
]))
story.append(screenshot('12-einstellungen.png', 'Einstellungen'))
story.append(PageBreak())

# ---- 15. Beobachtungsliste ----
story += h1('15. Beobachtungsliste')
story.append(p(
    'Über das Stern-Symbol lässt sich eine persönliche Beobachtungsliste führen — Arten, die man '
    'unbedingt einmal entdecken möchte. Gefundene Arten aus dieser Liste werden auf der Karte '
    'und in der Sammlung farblich hervorgehoben.'))
story.append(PageBreak())

# ---- 16. Datenschutz ----
story += h1('16. Datenschutz & Offline-Fähigkeit')
story.append(p(
    'WaldOhr speichert grundsätzlich alles lokal auf dem Gerät (IndexedDB) — Funde, Aufnahmen, '
    'Fotos, Einstellungen. Es gibt keine Nutzerkonten und keine automatische Übertragung an einen '
    'Server.'))
story.append(p('Ausnahmen, jeweils nur aktiv, wenn explizit eingerichtet:'))
story.append(bullets([
    'Gemini-Anreicherung sendet den Artnamen an Google, um eine Erklärung zu erhalten (nur mit '
    'eigenem, freiwillig hinterlegtem API-Schlüssel).',
    'Der BirdNET-Server-Modus sendet 3-Sekunden-Audiofenster an den in den Einstellungen '
    'hinterlegten Server.',
    'Die Partner-Kopplung (Kapitel 13) verbindet sich direkt (Peer-to-Peer) mit einem anderen '
    'Gerät, ohne dass Daten über einen dritten Server laufen.',
]))
story.append(PageBreak())

# ---- 17. Bekannte Einschränkungen ----
story += h1('17. Bekannte Einschränkungen')
story += [h2('BirdNET-Lizenz')]
story.append(p(
    'Die BirdNET-Modellgewichte stehen unter CC BY-NC-SA 4.0 (nicht-kommerziell, Weitergabe unter '
    'gleichen Bedingungen, Namensnennung). Für eine Veröffentlichung im Play Store, bei der das '
    'Modell direkt in der App enthalten wäre, ist vorab eine Rücksprache mit dem BirdNET/Cornell-'
    'Team nötig.'))
story += [h2('On-Device-Grenzen')]
story.append(p(
    'Echte On-Device-Erkennung ohne Internetverbindung ist mit dem aktuellen Browser-Ansatz nicht '
    'möglich: Das BirdNET-Modell benötigt Audio-Vorverarbeitungsschritte (STFT/RFFT), die die im '
    'Browser verfügbare TensorFlow.js/WASM-Laufzeit nicht ausführen kann. Das betrifft jede '
    'Web-basierte Lösung — auch eine als Play-Store-App verpackte Version dieser PWA. Eine echte '
    'Offline-Erkennung würde eine vollständig native App mit einem nativen TFLite-Plugin erfordern.'))
story += [h2('Kopplung im selben Netz')]
story.append(p(
    'Die Partner-Kopplung funktioniert aktuell nur, wenn sich beide (oder alle) Geräte im selben '
    'lokalen Netz befinden (gleiches WLAN oder gemeinsamer Hotspot) — nicht über getrennte '
    'Mobilfunknetze. Das ist eine bewusste Design-Entscheidung, um den QR-Code klein und leicht '
    'scannbar zu halten.'))
story.append(Spacer(1, 20 * mm))
story.append(HRFlowable(width='100%', thickness=0.6, color=STROKE))
story.append(Paragraph('WaldOhr · AppReich', ParagraphStyle('footer', parent=styles['WOSubtitle'], fontSize=9, textColor=FAINT, spaceBefore=8)))


# ---------------------------------------------------------------------------
def build():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = SimpleDocTemplate(
        OUT, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=16 * mm,
        title='WaldOhr – Benutzerhandbuch', author='AppReich',
    )

    def footer(c, d):
        c.saveState()
        c.setFont('Helvetica', 8)
        c.setFillColor(FAINT)
        c.drawRightString(A4[0] - 20 * mm, 10 * mm, f'Seite {d.page}')
        c.drawString(20 * mm, 10 * mm, 'WaldOhr – Benutzerhandbuch')
        c.restoreState()

    doc.build(story, onFirstPage=lambda c, d: None, onLaterPages=footer)
    print('geschrieben:', OUT)


if __name__ == '__main__':
    build()
