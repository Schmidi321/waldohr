#!/usr/bin/env python3
"""Erzeugt docs/WaldOhr-Anleitung.pdf aus dem Inhalt unten (Stand: v113).

Screenshots: erwartet PNG/JPG-Dateien in docs/assets/ mit den Namen, die unten in den
shot()/shots()-Aufrufen stehen. Fehlt eine Datei, wird ein Platzhalter-Rahmen mit
Bildunterschrift gedruckt statt eines echten Bilds -- einfach die Datei spaeter unter dem
passenden Namen ablegen und das Skript erneut laufen lassen (keine Codeaenderung noetig).

Hinweis: Die Standardschrift Helvetica kennt keine Emojis und keine Pfeile wie U+2192 --
fuer Menuepfade deshalb "›" verwenden.

Aufruf:  python scripts/generate_doc.py
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image, Table, TableStyle,
    ListFlowable, ListItem, HRFlowable, KeepTogether, Flowable
)

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(BASE, 'docs', 'assets')
OUT = os.path.join(BASE, 'docs', 'WaldOhr-Anleitung.pdf')

LIME = colors.HexColor('#7fa832')
DARK = colors.HexColor('#123524')
MUTED = colors.HexColor('#5a6b60')
FAINT = colors.HexColor('#8a9a8f')
STROKE = colors.HexColor('#c9d6cc')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle('WOTitle', parent=styles['Title'], fontSize=34, leading=40, textColor=DARK, spaceAfter=14))
styles.add(ParagraphStyle('WOSubtitle', parent=styles['Normal'], fontSize=13, textColor=MUTED, alignment=TA_CENTER, spaceAfter=4, leading=17))
styles.add(ParagraphStyle('WOH1', parent=styles['Heading1'], fontSize=19, textColor=DARK, spaceBefore=4, spaceAfter=10))
styles.add(ParagraphStyle('WOH2', parent=styles['Heading2'], fontSize=13.5, textColor=DARK, spaceBefore=12, spaceAfter=5, keepWithNext=1))
styles.add(ParagraphStyle('WOBody', parent=styles['Normal'], fontSize=10.3, leading=15, textColor=colors.HexColor('#1c2b22'), spaceAfter=8))
styles.add(ParagraphStyle('WOBullet', parent=styles['WOBody'], leftIndent=0, spaceAfter=4))
styles.add(ParagraphStyle('WOCaption', parent=styles['Normal'], fontSize=8.5, leading=11, textColor=FAINT, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10))
styles.add(ParagraphStyle('WONote', parent=styles['WOBody'], backColor=colors.HexColor('#eef5ec'), borderColor=LIME,
                          borderWidth=0.6, borderPadding=8, spaceBefore=12, spaceAfter=14))
styles.add(ParagraphStyle('WOTocEntry', parent=styles['Normal'], fontSize=10, textColor=MUTED, spaceAfter=2, leftIndent=12))
styles.add(ParagraphStyle('WOTocSection', parent=styles['Normal'], fontSize=11, textColor=DARK, spaceBefore=7, spaceAfter=2, fontName='Helvetica-Bold'))


def h1(text):
    return [HRFlowable(width='100%', thickness=1.4, color=LIME, spaceAfter=8), Paragraph(text, styles['WOH1'])]


def h2(text):
    return Paragraph(text, styles['WOH2'])


def p(text):
    return Paragraph(text, styles['WOBody'])


def note(text, label='Tipp'):
    return Paragraph(f'<b>{label}:</b> ' + text, styles['WONote'])


def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(it, styles['WOBullet']), leftIndent=14, bulletColor=LIME) for it in items],
        bulletType='bullet', start='circle', spaceAfter=8,
    )


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(it, styles['WOBullet']), leftIndent=16) for it in items],
        bulletType='1', bulletFontName='Helvetica-Bold', bulletColor=LIME, spaceAfter=8,
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
        c.drawCentredString(self.width / 2, self.height / 2 + 6, 'Screenshot folgt')
        c.setFont('Helvetica-Oblique', 8)
        c.drawCentredString(self.width / 2, self.height / 2 - 8, self.label)
        c.restoreState()


def _image(filename, max_width, max_height):
    path = os.path.join(ASSETS, filename)
    if not os.path.isfile(path):
        return PlaceholderBox(max_width, max_height * 0.55, filename)
    img = Image(path)
    iw, ih = img.imageWidth, img.imageHeight
    scale = min(max_width / iw, max_height / ih)
    img.drawWidth = iw * scale
    img.drawHeight = ih * scale
    img.hAlign = 'CENTER'
    return img


def shot(filename, caption, max_width=62 * mm, max_height=96 * mm):
    """Ein Handy-Screenshot, zentriert, mit Bildunterschrift."""
    return KeepTogether([_image(filename, max_width, max_height), Paragraph(caption, styles['WOCaption'])])


def shots(items, max_height=96 * mm):
    """Zwei oder drei Screenshots nebeneinander: items = [(datei, unterschrift), ...]."""
    n = len(items)
    col = (170 * mm) / n
    w = min(col - 8 * mm, 60 * mm if n == 2 else 52 * mm)
    row_img = [_image(f, w, max_height) for f, _ in items]
    row_cap = [Paragraph(c, styles['WOCaption']) for _, c in items]
    t = Table([row_img, row_cap], colWidths=[col] * n)
    t.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, 0), 'BOTTOM'),
        ('VALIGN', (0, 1), (-1, 1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return t


# ---------------------------------------------------------------------------
# Inhalt
# ---------------------------------------------------------------------------
story = []

# ---- Titelseite ----
story.append(Spacer(1, 55 * mm))
story.append(Paragraph('WaldOhr', styles['WOTitle']))
story.append(Paragraph('Vogelstimmen erkennen — Benutzerhandbuch', ParagraphStyle(
    'sub2', parent=styles['WOSubtitle'], fontSize=15, textColor=DARK)))
story.append(Spacer(1, 6 * mm))
story.append(Paragraph(
    'Dein Fernglas fürs Ohr: Halte das Smartphone in die Natur und WaldOhr erkennt, welcher Vogel '
    'gerade singt. Fotografiere ihn, finde ihn auf der Karte wieder und führe dein eigenes Feldbuch — '
    'ohne Konto, alles bleibt auf deinem Gerät.', styles['WOSubtitle']))
story.append(Spacer(1, 30 * mm))
story.append(Paragraph('Ausführliche Anleitung · Stand: Version 113', ParagraphStyle(
    'sub3', parent=styles['WOSubtitle'], fontSize=10, textColor=FAINT)))
story.append(PageBreak())

# ---- Inhaltsverzeichnis (manuell, ohne Seitenzahlen) ----
story += h1('Inhalt')
toc = [
    ('1. Willkommen', ['Was ist WaldOhr?', 'Demo-Modus und echte Erkennung', 'Offline, ohne Konto']),
    ('2. Erste Schritte', ['Start & Berechtigungen', 'Die Kopfzeile', 'Die fünf Tabs im Überblick']),
    ('3. Lauschen', ['Ein Tipp startet und stoppt', 'Spektrogramm & Pegel', '„Jetzt zu hören“', 'Was gespeichert wird']),
    ('4. Richtung finden', ['So funktioniert der Scan', 'Schritt für Schritt', 'Wie genau ist das?']),
    ('5. Automatisch lauschen', ['Morgenchor', 'Nacht-Modus', 'Dauerüberwachung']),
    ('6. Karte', ['Punkte & Farben', 'Position setzen', 'Route aufzeichnen']),
    ('7. Funde', ['Arten', 'Orte', 'Statistik', 'Suchliste']),
    ('8. Der Arten-Steckbrief', []),
    ('9. Foto', ['Kamera', 'Galerie & Teilen', 'Licht', 'Wecker', 'Tipps']),
    ('10. Feldbuch', ['Punkt- und Transekt-Zählung', 'Protokolle', 'Export']),
    ('11. Einstellungen', ['Erkennung', 'Kamera', 'Daten', 'Dienste & Schlüssel', 'Über & Hilfe']),
    ('12. Datenschutz & Offline-Fähigkeit', []),
    ('13. Grenzen & ehrliche Hinweise', []),
]
for section, subs in toc:
    story.append(Paragraph(section, styles['WOTocSection']))
    if subs:
        story.append(Paragraph(' · '.join(subs), styles['WOTocEntry']))
story.append(PageBreak())

# ---- 1. Willkommen ----
story += h1('1. Willkommen')
story.append(p(
    'WaldOhr ist eine mobile Web-App (PWA), die Vogelstimmen und andere Tierlaute über das Mikrofon '
    'erkennt, die Funde auf einer Karte verortet, sammelt und auswertet. Dazu kommen eine Kamera für '
    'Belegfotos, ein Werkzeug, mit dem du grob herausfindest, <b>aus welcher Richtung</b> ein Ruf kommt, '
    'und ein Feldbuch für strukturierte Zählungen.'))
story.append(p(
    'Die App läuft im Browser oder als installierte App auf dem Startbildschirm. Beim ersten Start '
    'begrüßt dich ein kurzer Startbildschirm — ein Tipp auf <b>„Los geht\'s“</b> führt direkt in den '
    'Tab <b>Lauschen</b>.'))
story.append(shot('01-splash.jpg', 'Der Startbildschirm', max_height=80 * mm))

story.append(h2('Demo-Modus und echte Erkennung'))
story.append(p(
    'Für echte Erkennung braucht WaldOhr eine Internet-Verbindung zu einem <b>BirdNET-Server</b>, dessen '
    'Adresse du unter <i>Einstellungen › Dienste &amp; Schlüssel</i> einträgst. Solange dort nichts steht, '
    'läuft der <b>Demo-Modus</b>: Die Kopfzeile zeigt dann „Demo“, ein gelber Hinweis erscheint über dem '
    'Kreis, und die Treffer sind <b>zufällig</b>. Sie sind in der Liste als „Demo“ markiert und werden '
    'nicht gespeichert — so kannst du die Bedienung in Ruhe ausprobieren, ohne dass sich Fantasie-Funde '
    'in deiner Sammlung ansammeln.'))
story.append(note(
    'Alle Screenshots in dieser Anleitung stammen aus dem Demo-Modus. Die Funde in Karte, Funde und '
    'Statistik sind die Beispiel-Daten, die WaldOhr beim allerersten Start anlegt, damit diese Bereiche '
    'nicht leer sind.', 'Hinweis'))

story.append(h2('Offline, ohne Konto'))
story.append(bullets([
    '<b>Keine Anmeldung</b> — die App ist sofort nutzbar, es gibt kein Konto.',
    '<b>Alles bleibt auf dem Gerät</b> — Funde, Aufnahmen, Fotos und Einstellungen werden lokal '
    'gespeichert, keine Cloud.',
    '<b>Offline installierbar</b> — einmal geladen, startet die Oberfläche auch ohne Netz. Nur die echte '
    'Erkennung (BirdNET-Server), Kartenkacheln, Artfotos und optionale Dienste brauchen Internet.',
]))
story.append(PageBreak())

# ---- 2. Erste Schritte ----
story += h1('2. Erste Schritte')
story.append(h2('Start & Berechtigungen'))
story.append(p(
    'WaldOhr fragt nach Berechtigungen erst dann, wenn eine Funktion sie wirklich braucht:'))
story.append(bullets([
    '<b>Mikrofon</b> — fürs Lauschen, den Richtungs-Scan und Tonaufnahmen.',
    '<b>Standort</b> — damit Funde auf der Karte und unter „Funde“ landen, für die Route und für die '
    'Sonnenzeiten (Morgenchor, Licht, Wecker).',
    '<b>Kamera</b> — für Fotos, Videos und Zeitraffer.',
    '<b>Bewegung &amp; Ausrichtung</b> — für den Kompass beim Richtungs-Scan und den Live-Pfeil im '
    'Steckbrief. Auf dem iPhone fragt Safari danach.',
]))
story.append(p(
    'Keine dieser Berechtigungen ist Pflicht: Ohne Standort funktioniert die Erkennung trotzdem, die Funde '
    'erscheinen dann nur nicht auf der Karte.'))

story.append(h2('Die Kopfzeile'))
story.append(bullets([
    '<b>Server- bzw. „Demo“-Chip</b> — zeigt, ob WaldOhr mit dem BirdNET-Server verbunden ist '
    '(oder im Demo-Modus läuft).',
    '<b>GPS-Chip</b> — Standortstatus. Grün heißt: Position vorhanden.',
    '<b>Zahnrad</b> — öffnet die Einstellungen; dort findest du auch die <b>Hilfe</b> (Fragezeichen).',
]))

story.append(h2('Die fünf Tabs im Überblick'))
story.append(p('Über die Leiste am unteren Bildschirmrand wechselst du zwischen den fünf Bereichen:'))
story.append(bullets([
    '<b>Lauschen</b> — Mikrofon, Live-Erkennung und „Richtung finden“. Der Startbereich der App.',
    '<b>Karte</b> — alle verorteten Funde, deine Position und die Routenaufzeichnung.',
    '<b>Funde</b> — deine Arten, Fundorte, Statistik und die Suchliste.',
    '<b>Foto</b> — Kamera, Galerie, Licht &amp; Wetter, Fotografen-Wecker und Tipps.',
    '<b>Feldbuch</b> — Punkt- und Transekt-Zählungen, Protokolle und Export.',
]))
story.append(PageBreak())

# ---- 3. Lauschen ----
story += h1('3. Lauschen')
story.append(h2('Ein Tipp startet und stoppt'))
story.append(p(
    'Tippe auf den <b>großen Kreis</b> — Mikrofon und Erkennung starten zusammen. Der Kreis zeigt dann '
    '„Lauscht“ und die Zeit seit dem Start. Nochmal tippen stoppt beides. WaldOhr wertet laufend kurze '
    'Ausschnitte von drei Sekunden aus.'))
story.append(shots([
    ('02-lauschen.jpg', 'Bereit: ein Tipp auf den Kreis startet'),
    ('03-lauschen-aktiv.jpg', 'Beim Lauschen: Spektrogramm und Live-Liste (Demo)'),
], max_height=84 * mm))
story.append(h2('Spektrogramm & Pegel'))
story.append(p(
    'Unter dem Kreis läuft das <b>Spektrogramm</b> mit: Es zeigt, welche Tonhöhen gerade ankommen — so '
    'siehst du einen Gesang, noch bevor eine Art erkannt ist. Die dünne Leiste an seiner Unterkante ist '
    'der <b>Mikrofonpegel</b>.'))
story.append(h2('„Jetzt zu hören“'))
story.append(p(
    'Hier erscheinen alle Arten der letzten Sekunden mit ihrer Erkennungssicherheit in Prozent. '
    '„Neu“ steht nur beim allerersten Fund einer Art. Jede Zeile hat drei Knöpfe: '
    '<b>Richtung finden</b> (Kapitel 4), <b>Foto</b> und <b>Ruf aufnehmen</b> — die Aufnahme wird mit dem '
    'Artnamen beschriftet. Ein Tipp auf den Namen öffnet den Steckbrief der Art (Kapitel 8).'))
story.append(note(
    'Im Demo-Modus zeigen die Zeilen nur den Richtungs-Knopf: Foto und Aufnahme würden sonst mit einem '
    'zufälligen Artnamen dauerhaft in der Galerie landen.', 'Hinweis'))
story.append(h2('Was gespeichert wird'))
story.append(p(
    'Nur Funde ab <b>70 % Sicherheit</b> zählen für Karte, Funde und Statistik. Ab <b>85 %</b> speichert '
    'WaldOhr den Ruf zusätzlich automatisch als kurze Tonaufnahme in der Galerie — höchstens einmal pro Art '
    'und Tag. Beide Schwellen und die Länge der automatischen Aufnahme stellst du unter '
    '<i>Einstellungen › Erkennung</i> ein.'))
story.append(p(
    'Unter dem Kreis führt der Knopf <b>„Zeitplan“</b> zum automatischen Lauschen (Kapitel 5). Läuft eine '
    'Zählung aus dem Feldbuch, zeigt ein Banner über der Liste die verbleibende Zeit.'))
story.append(PageBreak())

# ---- 4. Richtung finden ----
story += h1('4. Richtung finden')
story.append(p(
    'Mit <b>„Richtung finden“</b> findest du grob heraus, aus welcher Richtung ein Ruf kommt — mit nur '
    'einem Handy und ohne Zubehör. Du startest den Scan über den Knopf rechts über der Liste „Jetzt zu '
    'hören“, direkt bei einer erkannten Art oder im Steckbrief.'))
story.append(h2('So funktioniert der Scan'))
story.append(p(
    'Dein Körper schirmt Geräusche von hinten ab. Hältst du das Handy vor die Brust und drehst dich einmal '
    'im Kreis, ist der Ruf deshalb in seiner Richtung am lautesten. WaldOhr verbindet den Pegel im '
    'Frequenzbereich der Vogelstimmen mit der Kompassrichtung — gezählt wird nur, während der Vogel '
    'tatsächlich singt.'))
story.append(h2('Schritt für Schritt'))
story.append(steps([
    'Handy <b>flach vor die Brust</b> halten, die Oberkante zeigt nach vorn. <b>„Scan starten“</b> tippen.',
    '<b>Langsam einmal im Kreis drehen</b> (ca. 20 Sekunden), am besten, während der Vogel singt. Der Ring '
    'füllt sich mit Ruf-Daten; oben siehst du, aus wie vielen Grad schon Daten vorliegen.',
    'Sobald eine Richtung erkennbar ist, <b>„Richtung übernehmen“</b> tippen. Ein Pfeil zeigt dorthin, '
    'und WaldOhr sagt dir, wie weit du dich nach links oder rechts drehen musst.',
    'In Pfeilrichtung gehen und <b>erneut scannen</b>, wenn du näher dran bist.',
]))
story.append(shots([
    ('04-scan-start.jpg', 'Start: kurze Anleitung'),
    ('05-scan-laeuft.jpg', 'Beim Drehen füllt sich der Ring'),
    ('06-scan-ergebnis.jpg', 'Ergebnis: Pfeil und Drehhinweis'),
], max_height=80 * mm))
story.append(h2('Wie genau ist das?'))
story.append(note(
    'Ehrlich gesagt: Das Ergebnis ist eine <b>grobe Richtung (±30–45°)</b>. Singen mehrere Vögel '
    'gleichzeitig, gewinnt der lauteste. Weitere Runden machen das Ergebnis genauer. Ohne genug Ruf-Daten '
    'aus allen Richtungen zeigt WaldOhr bewusst kein Ergebnis an.', 'Gut zu wissen'))
story.append(p(
    'Der Scan braucht einen Kompass und funktioniert deshalb nur auf dem Handy. Auf dem iPhone muss '
    '„Bewegung &amp; Ausrichtung“ für Safari erlaubt sein — fehlt die Freigabe, sagt dir WaldOhr, wo du sie '
    'einschaltest.'))
story.append(PageBreak())

# ---- 5. Automatisch lauschen ----
story += h1('5. Automatisch lauschen')
story.append(p(
    'Der Knopf <b>„Zeitplan“</b> unter dem Kreis öffnet die Automatik. WaldOhr startet das Lauschen dann '
    'von selbst:'))
story.append(bullets([
    '<b>Morgenchor</b> — startet kurz vor Sonnenaufgang, wenn die Vögel am lautesten singen. Wie viele '
    'Minuten vorher, stellst du mit dem Regler ein; die App zeigt die errechnete Startzeit an. Braucht GPS.',
    '<b>Nacht-Modus</b> — startet zu einer festen Uhrzeit, optional mit Endzeit. Für Eulen und Nachtzieher.',
    '<b>Dauerüberwachung</b> — lauscht ab sofort für eine feste Dauer (15 Minuten bis 8 Stunden). Auf '
    'Wunsch mit <b>Trigger-Aufnahme</b>: Sie startet eine Aufnahme, sobald ein Geräusch die eingestellte '
    'Empfindlichkeit überschreitet.',
]))
story.append(shot('07-automatik.jpg', 'Automatisch lauschen: Morgenchor, Nacht-Modus, Dauerüberwachung'))
story.append(note(
    'Die Automatik funktioniert nur, solange WaldOhr geöffnet ist. Schalte dafür unter '
    '<i>Einstellungen › Erkennung</i> „Display an lassen“ ein.'))
story.append(PageBreak())

# ---- 6. Karte ----
story += h1('6. Karte')
story.append(h2('Punkte & Farben'))
story.append(p(
    'Funde erscheinen als farbige Punkte: <b>grün</b> = häufig, <b>gelb</b> = selten, <b>rot</b> = Säugetier, '
    '<b>blau</b> = Art aus deiner Suchliste. Dein Standort ist die <b>cyanfarbene Figur</b>. Punkt antippen '
    'zeigt den Namen, nochmal antippen öffnet den Steckbrief. Oben links steht, wie viele Funde die Karte '
    'enthält.'))
story.append(shot('08-karte.jpg', 'Die Karte mit Funden, eigener Position und Legende'))
story.append(h2('Position setzen'))
story.append(p(
    'Rechts oben findest du <b>Position setzen</b> (Stecknadel): danach auf die Karte tippen, um deinen '
    'genauen Standpunkt festzulegen. Das ist im Wald oft präziser als GPS und gilt für neue Funde, bis du '
    'dich bewegst — dann zählt automatisch wieder GPS. Darunter zeigt <b>Alle Funde zeigen</b> wieder den '
    'ganzen Bestand.'))
story.append(h2('Route aufzeichnen'))
story.append(p(
    '<b>Route aufzeichnen</b> speichert deinen GPS-Track (ein Punkt alle 15 Sekunden) — unabhängig davon, '
    'ob gerade gelauscht wird. Am Ende kannst du ihn als <b>GPX-Datei</b> exportieren, etwa für '
    'Wander-Apps.'))
story.append(note(
    'Die Transekt-Zählung im Feldbuch nutzt dieselbe Aufzeichnung (dort alle 10 Sekunden). Es läuft immer '
    'nur eine Aufzeichnung gleichzeitig.', 'Hinweis'))
story.append(PageBreak())

# ---- 7. Funde ----
story += h1('7. Funde')
story.append(p(
    'Der Tab <b>Funde</b> hat drei Ansichten — <b>Arten</b>, <b>Orte</b> und <b>Statistik</b>. Darunter '
    'wählst du den Bereich: <b>Heute hier</b> (heutige Funde im Umkreis von etwa 3 km) oder <b>Alle</b>.'))
story.append(h2('Arten'))
story.append(p(
    'Oben stehen Kennzahlen (Arten, Erkennungen, seltene Arten), darunter eine Karte pro Art mit Foto, '
    'Anzahl und letztem Fundzeitpunkt. Ein Abspiel-Symbol auf einer Artkarte spielt deine eigene Aufnahme '
    'dieser Art. Antippen öffnet den Steckbrief. Über das Menü (drei Punkte) in „Heute hier“ lassen sich '
    'die heutigen Funde an diesem Ort löschen.'))
story.append(shots([
    ('09-funde-arten.jpg', 'Arten — Bereich „Alle“'),
    ('10-funde-orte.jpg', 'Orte — Funde nach Fundort'),
]))
story.append(h2('Orte'))
story.append(p('Fasst die Funde nach Fundort zusammen: wann du dort warst, wie viele Arten und welche.'))
story.append(h2('Statistik'))
story.append(p(
    'Kennzahlen (Erkennungen, Arten, Tage in Serie, diese Woche), die häufigsten Arten, ein '
    'Balkendiagramm der letzten 14 Tage und die <b>Aktivität über den Tag</b> — dort zeigt sich meist der '
    'Morgenchor als Spitze.'))
story.append(shots([
    ('11-statistik.jpg', 'Statistik: Kennzahlen und häufigste Arten'),
    ('12-statistik-diagramme.jpg', 'Letzte 14 Tage und Tagesverlauf'),
]))
story.append(h2('Suchliste'))
story.append(p(
    'Markiere Wunsch-Arten mit dem <b>Stern</b> — über den Knopf <b>„Suchliste“</b> hier oder im Steckbrief '
    'einer Art. Wird eine davon erkannt, <b>vibriert das Handy</b> und ein Hinweis erscheint. Seltene Arten '
    'lösen diesen Alarm automatisch aus. Die Suche kennt alle rund 6.500 BirdNET-Arten.'))
story.append(shot('13-suchliste.jpg', 'Die Suchliste: Art suchen und mit dem Stern markieren', max_height=90 * mm))
story.append(PageBreak())

# ---- 8. Steckbrief ----
story += h1('8. Der Arten-Steckbrief')
story.append(p(
    'Ein Tipp auf eine Art — in der Live-Liste, unter Funde oder auf der Karte — öffnet ihren Steckbrief:'))
story.append(bullets([
    '<b>Schnellknöpfe</b>: <b>Suchliste</b> (Stern), <b>Richtung</b> (startet den Richtungs-Scan für diese '
    'Art), <b>Foto</b> und <b>Wikipedia</b>.',
    '<b>Was bedeutet der Ruf?</b> — Gesang, Warnruf &amp; Co. kurz erklärt.',
    '<b>Steckbrief</b> — Größe, Lebensraum, Besonderheiten.',
    '<b>Foto-Tipp</b> — erscheint, wenn ein Gemini-API-Key hinterlegt ist; Gemini erweitert dann auch die '
    'Texte oben.',
    '<b>Letzter Fund</b> — wann und wo die Art zuletzt erkannt wurde.',
    '<b>Richtung zum letzten Fund</b> — Entfernung und Peilung zum letzten Fundort. Mit '
    '<b>„Kompass aktivieren“</b> dreht sich der Pfeil live mit.',
    '<b>Ruf anhören</b> — spielt eine echte Aufnahme von Xeno-canto ab (dafür ist ein kostenloser '
    'Xeno-canto-Key in den Einstellungen nötig).',
]))
story.append(shot('14-steckbrief.jpg', 'Steckbrief des Buchfinks'))
story.append(PageBreak())

# ---- 9. Foto ----
story += h1('9. Foto')
story.append(p(
    'Oben im Tab sitzt der große Knopf <b>„Kamera öffnen“</b>, darunter vier Bereiche: Galerie, Licht, '
    'Wecker und Tipps.'))
story.append(h2('Kamera'))
story.append(p(
    'Unten über dem Auslöser wählst du <b>Foto</b>, <b>Video</b> oder <b>Zeitraffer</b>. Zoomen geht mit dem '
    'Regler am rechten Rand oder mit zwei Fingern — auch ohne Hardware-Zoom; gespeichert wird genau der '
    'sichtbare Ausschnitt. Im Foto-Modus gibt es außerdem <b>Serienaufnahme</b> (2 Sekunden) und '
    '<b>Intervallaufnahme</b> (alle 3 Sekunden). Oben rechts: Fadenkreuz, Kamera wechseln und der direkte Weg '
    'zur Galerie.'))
story.append(p(
    '<b>Auto-Zoom</b> (im Video-Modus über das Symbol unter dem Zoomregler): fährt langsam rein oder raus — '
    'ohne am Handy zu wackeln. Tempo (schnell/langsam) und Steuerung (Start nach 3 Sekunden oder sanftes '
    'Stoppen) sind wählbar. Für Linkshänder lassen sich Auslöser und Zoom in den Einstellungen spiegeln.'))
story.append(shots([
    ('15-kamera.jpg', 'Kamera im Foto-Modus'),
    ('16-kamera-video.jpg', 'Video-Modus mit Auto-Zoom-Panel'),
]))
story.append(Paragraph(
    'Kamerabild in den Screenshots: Rotkehlchen, Foto Francis C. Franklin, CC BY-SA 3.0, Wikimedia Commons.',
    styles['WOCaption']))
story.append(note('Bei starkem Digital-Zoom lieber näher heran statt ganz aufziehen — die Schärfe bleibt so besser.'))
story.append(h2('Galerie & Teilen'))
story.append(p(
    'Die Galerie sammelt alle Tonaufnahmen und Fotos: automatisch gespeicherte Rufe, Aufnahmen aus der '
    'Live-Liste, Fotos und Videos. Mit <b>„Tonclip“</b> nimmst du direkt hier einen Clip auf. Jeder Eintrag '
    'lässt sich abspielen, <b>zuschneiden</b>, herunterladen, teilen und löschen.'))
story.append(p(
    'Beim Teilen eines Fotos hast du zwei Wege: eine fertige <b>Foto-Karte</b> (1080 × 1080 Pixel) oder ein '
    '<b>Video aus Foto + Tonaufnahme</b> — ideal für soziale Netzwerke.'))
story.append(shots([
    ('17-galerie.jpg', 'Galerie mit einem Tonclip'),
    ('18-licht.jpg', 'Licht & Wetter für den Standort'),
], max_height=80 * mm))
story.append(h2('Licht'))
story.append(p(
    'Goldene und blaue Stunde morgens und abends, Sonnenauf- und -untergang, das aktuelle Wetter und der '
    'Mond — jeweils für deinen Standort.'))
story.append(h2('Wecker'))
story.append(p(
    'Der <b>Fotografen-Wecker</b> weckt dich rechtzeitig zum Sonnenaufgang. Ein Tipp auf die '
    'Sonnenaufgangs-Kachel („Lichtphasen“) zeigt die Dämmerungsphasen von astronomisch bis zur goldenen '
    'Stunde. Weckzeit frei wählbar, auf Wunsch nur Vibration. Wie die Automatik funktioniert der Wecker nur, '
    'solange WaldOhr geöffnet bleibt.'))
story.append(h2('Tipps'))
story.append(p(
    'Kurze Ratschläge zu Ethik und Bildqualität — vom Abstand zu Brutplätzen über die Sonne im Rücken bis '
    'zum Fokus aufs Auge. Der wichtigste steht ganz oben: Kein Foto ist wichtiger als ein gestresstes Tier.'))
story.append(shots([
    ('19-wecker.jpg', 'Fotografen-Wecker'),
    ('20-tipps.jpg', 'Tipps für Naturfotos'),
], max_height=80 * mm))
story.append(PageBreak())

# ---- 10. Feldbuch ----
story += h1('10. Feldbuch')
story.append(p(
    'Das Feldbuch bietet strukturierte Zählmethoden für systematische Kartierungen — über die freie '
    'Live-Erkennung hinaus. Es hat drei Bereiche: <b>Zählungen</b>, <b>Protokolle</b> und <b>Export</b>.'))
story.append(h2('Punkt- und Transekt-Zählung'))
story.append(bullets([
    '<b>Punkt-Zählung</b> — 5 Minuten nach BirdLife-Standard von einem festen Standort aus; alle erkannten '
    'Rufe werden automatisch erfasst.',
    '<b>Transekt-Zählung</b> — du läufst eine Strecke ab, GPS zeichnet die Route auf, das Mikrofon lauscht '
    'durchgehend. Am Ziel beendest du die Zählung selbst und siehst Strecke und Arten.',
]))
story.append(p(
    'Beide Zählungen laufen auch weiter, wenn du in den Tab Lauschen wechselst — ein Banner über der Liste '
    'zeigt den Stand.'))
story.append(h2('Protokolle'))
story.append(p(
    'Listet alle abgeschlossenen Zählungen mit ihren Arten. Transekte lassen sich als GPX-Datei '
    'exportieren.'))
story.append(shots([
    ('21-zaehlungen.jpg', 'Zählungen'),
    ('23-export.jpg', 'Export — Bereich „Alles“'),
]))
story.append(h2('Export'))
story.append(p(
    'Die zentrale Stelle für den Datenexport: <b>eBird CSV</b> (Cornell Lab), <b>ornitho.de CSV</b> '
    '(DDA), <b>BirdNET Notebook CSV</b> (Einzelfunde mit Konfidenz) und <b>NABU / Naturgucker JSON</b>. '
    'Wähle „Heute hier“ oder „Alles“, auf Wunsch nur ausgewählte Sitzungen. Exportiert werden alle Funde ab '
    'der eingestellten Erkennungssicherheit — mit Koordinaten und Uhrzeit.'))
story.append(PageBreak())

# ---- 11. Einstellungen ----
story += h1('11. Einstellungen')
story.append(p(
    'Über das <b>Zahnrad</b> rechts oben. Änderungen werden sofort gespeichert. Die Einstellungen sind in '
    'Gruppen geordnet:'))
story.append(h2('Erkennung'))
story.append(bullets([
    '<b>In Funde aufnehmen ab</b> (Standard 70 %) — darunter erscheinen Arten nur live, nicht in Funde, '
    'Karte und Statistik.',
    '<b>Ruf automatisch speichern ab</b> (Standard 85 %) und die <b>Länge der automatischen Aufnahme</b> '
    '(3, 5, 10 oder 60 Sekunden).',
    '<b>Mikrofon</b> — externes Mikrofon (USB-C, Bluetooth, Richtmikrofon) wählen, sonst das eingebaute.',
    '<b>Display an lassen</b> — der Bildschirm geht beim Lauschen nicht aus.',
]))
story.append(h2('Kamera'))
story.append(bullets([
    '<b>Auslöseton</b> — Klick beim Fotografieren.',
    '<b>Linkshänder</b> — Auslöser und Zoom gespiegelt.',
]))
story.append(shots([
    ('24-einstellungen.jpg', 'Erkennung'),
    ('25-einstellungen-daten.jpg', 'Kamera, Daten, Dienste'),
    ('26-dienste.jpg', 'Dienste & Schlüssel'),
], max_height=82 * mm))
story.append(h2('Daten'))
story.append(bullets([
    '<b>Backup erstellen</b> — Funde, Fotos und Aufnahmen als Datei sichern.',
    '<b>Backup wiederherstellen</b> — wird zu den vorhandenen Daten hinzugefügt.',
    '<b>Alle Funde löschen</b> — unwiderruflich; WaldOhr fragt vorher nach.',
]))
story.append(note(
    'WaldOhr speichert alles nur auf diesem Gerät. Sichere regelmäßig, z. B. in einen Cloud-Ordner — '
    'besonders vor einem Handywechsel oder App-Update.', 'Wichtig'))
story.append(h2('Dienste & Schlüssel (erweitert)'))
story.append(bullets([
    '<b>BirdNET-Server</b> — Adresse deines Erkennungs-Servers (z. B. ein HuggingFace-Space). Leer = '
    'Demo-Modus. Nach „Übernehmen“ lädt die App neu.',
    '<b>Gemini-API-Key</b> — erklärt Ruf-Bedeutung und Steckbrief ausführlicher und liefert Foto-Tipps. '
    'Der Key bleibt nur auf diesem Gerät.',
    '<b>Xeno-canto-API-Key</b> — für „Ruf anhören“ mit echten Aufnahmen; kostenlos bei xeno-canto.org.',
]))
story.append(h2('Über & Hilfe'))
story.append(p(
    '<b>Hilfe &amp; Anleitung</b> erklärt alle Funktionen kurz und Schritt für Schritt direkt in der App — '
    'erreichbar auch über das Fragezeichen oben in den Einstellungen. Darunter stehen Hinweise zu BirdNET, '
    'den Artfotos (Wikipedia/Wikimedia Commons), den Schriften und die Versionsnummer.'))
story.append(shot('27-hilfe.jpg', 'Die Hilfe in der App', max_height=90 * mm))
story.append(PageBreak())

# ---- 12. Datenschutz ----
story += h1('12. Datenschutz & Offline-Fähigkeit')
story.append(p(
    'WaldOhr speichert grundsätzlich alles lokal auf dem Gerät — Funde, Aufnahmen, Fotos und '
    'Einstellungen. Es gibt keine Nutzerkonten und keine automatische Übertragung an einen eigenen Server.'))
story.append(p('Daten verlassen das Gerät nur in diesen Fällen:'))
story.append(bullets([
    '<b>BirdNET-Server</b> (nur wenn eingetragen): Die kurzen Audio-Ausschnitte gehen zur Erkennung an den '
    'von dir hinterlegten Server.',
    '<b>Gemini</b> (nur mit eigenem Key): Der Artname wird an Google gesendet, um Erklärungen zu erhalten.',
    '<b>Xeno-canto</b> (nur mit eigenem Key): Abruf echter Vogelrufe.',
    '<b>Karten, Artfotos, Wetter</b>: Kartenkacheln (OpenStreetMap), Artfotos (Wikimedia Commons) und '
    'Wetterdaten werden beim Anzeigen aus dem Internet geladen.',
    '<b>Teilen und Export</b>: nur, wenn du selbst etwas teilst oder eine Datei exportierst.',
]))
story.append(Spacer(1, 8 * mm))

# ---- 13. Grenzen ----
story += h1('13. Grenzen & ehrliche Hinweise')
story.append(h2('Echte Erkennung braucht den Server'))
story.append(p(
    'Ohne BirdNET-Server läuft nur der Demo-Modus mit zufälligen Treffern. Eine vollständige Erkennung '
    'direkt im Browser ist mit dem aktuellen BirdNET-Modell nicht zuverlässig möglich: Es nutzt '
    'Audio-Vorverarbeitungsschritte, die die im Browser verfügbare Laufzeit nicht ausführen kann.'))
story.append(h2('Richtung finden ist grob'))
story.append(p(
    'Der Richtungs-Scan liefert eine Richtung mit etwa ±30–45°. Mehrere gleichzeitig singende Vögel, Wind '
    'oder Echos zwischen Gebäuden machen das Ergebnis unsicherer. Er braucht ein Handy mit Kompass.'))
story.append(h2('Automatik nur bei geöffneter App'))
story.append(p(
    'Morgenchor, Nacht-Modus, Dauerüberwachung und Fotografen-Wecker funktionieren nur, solange WaldOhr '
    'geöffnet ist und der Bildschirm an bleibt.'))
story.append(h2('BirdNET-Lizenz'))
story.append(p(
    'Die Erkennung basiert auf BirdNET, entwickelt vom K. Lisa Yang Center for Conservation Bioacoustics am '
    'Cornell Lab of Ornithology mit der TU Chemnitz. Die Modellgewichte stehen unter CC BY-NC-SA 4.0 '
    '(nicht-kommerziell, Namensnennung, Weitergabe unter gleichen Bedingungen).'))
story.append(Spacer(1, 16 * mm))
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
