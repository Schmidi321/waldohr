// Arten-Katalog — zentrale Datenquelle für Erkennung & UI.
// rarity: 'common' | 'rare' | 'mammal'  (steuert Farbe/Badge)
import { EXTRA_SPECIES } from './species-extra.js';

const BIRD = '<path d="M16 7c1.5 0 3 1 3 3 0 3-3 5-3 5l-7 1c-3 0-5-2-5-4 0-1 .5-2 2-2"/><path d="M16 7l4-2-2 3"/><circle cx="15" cy="8.5" r=".8" fill="currentColor" stroke="none"/><path d="M9 15l-2 4M12 16l-1 4"/>';
const FISHER = '<path d="M5 13c3-1 6-4 9-4s5 2 5 4-2 4-5 4-7-2-9-4z"/><path d="M5 13l-2 3M19 13l2 1"/><circle cx="15" cy="11" r=".8" fill="currentColor" stroke="none"/>';
const DEER = '<path d="M7 14c0-3 2-6 5-6s5 3 5 6-2 5-5 5-5-2-5-5z"/><path d="M8 9l-1-4 3 3M16 9l1-4-3 3"/>';

const GREEN = ['#0e5840', '#0a4733'];
const BLUE  = ['#0a3a52', '#073047'];
const ROSE  = ['#3a1420', '#2e0f18'];

export const SPECIES = {
  amsel: {
    key:'amsel', name:'Amsel', sci:'Turdus merula', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Du hörst den <b style="color:var(--ink)">Reviergesang</b> eines Männchens – melodisch und flötend. Kurze, scharfe „tix-tix"-Rufe wären dagegen ein Warnsignal.',
    steckbrief:'Häufigster Brutvogel Deutschlands · 24–25 cm · singt von März bis Juli, oft in der Dämmerung.'
  },
  buchfink: {
    key:'buchfink', name:'Buchfink', sci:'Fringilla coelebs', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Der typische, abfallende Schlag endet in einem „Schnörkel" – ein <b style="color:var(--ink)">Reviergesang</b>. Ein hartes „pink-pink" ist sein Regenruf.',
    steckbrief:'Einer der häufigsten Vögel Europas · 14–16 cm · Wälder, Parks und Gärten.'
  },
  kohlmeise: {
    key:'kohlmeise', name:'Kohlmeise', sci:'Parus major', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Das klingelnde „zi-zi-bäh" ist <b style="color:var(--ink)">Revier- und Werbegesang</b>. Sehr variabel – Kohlmeisen haben ein großes Repertoire.',
    steckbrief:'Größte heimische Meise · 14 cm · Standvogel, ganzjährig zu hören.'
  },
  rotkehlchen: {
    key:'rotkehlchen', name:'Rotkehlchen', sci:'Erithacus rubecula', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein perlender, etwas wehmütiger Gesang – oft früh morgens und spät abends. Ein scharfes „tick-tick" signalisiert Erregung.',
    steckbrief:'12–14 cm · singt fast ganzjährig, an Laternen sogar nachts.'
  },
  zaunkoenig: {
    key:'zaunkoenig', name:'Zaunkönig', sci:'Troglodytes troglodytes', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Erstaunlich laut für seine Größe: ein langer, schmetternder Triller als <b style="color:var(--ink)">Reviergesang</b>.',
    steckbrief:'Einer der kleinsten Vögel Europas · 9–10 cm · liebt Unterholz und Hecken.'
  },
  buntspecht: {
    key:'buntspecht', name:'Buntspecht', sci:'Dendrocopos major', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Das schnelle <b style="color:var(--ink)">Trommeln</b> auf totem Holz markiert das Revier – kein Picken nach Futter. Ein scharfes „kix" ist der Ruf.',
    steckbrief:'Häufigster Specht · 23 cm · trommelt v. a. im Spätwinter und Frühjahr.'
  },
  eisvogel: {
    key:'eisvogel', name:'Eisvogel', sci:'Alcedo atthis', rarity:'rare',
    icon:FISHER, grad:BLUE, accent:'#67e8f9',
    meaning:'Ein hoher, scharfer „tiht"-Pfiff im Flug über dem Wasser – meist ein <b style="color:var(--ink)">Kontakt- oder Standortruf</b>.',
    steckbrief:'„Fliegender Edelstein" · 16–18 cm · an sauberen, fischreichen Gewässern · selten.'
  },
  reh: {
    key:'reh', name:'Reh', sci:'Capreolus capreolus', rarity:'mammal',
    icon:DEER, grad:ROSE, accent:'#fb7185',
    meaning:'Das raue „Bellen" (Schrecken) ist ein <b style="color:var(--ink)">Warnruf</b>. Das feine Fiepen ruft ein Kitz – oder die Ricke ihr Kitz.',
    steckbrief:'Häufigstes Wildtier im Wald · dämmerungs- und nachtaktiv · Säugetier.'
  },

  // ---- Weitere heimische Arten (fest verbaut, ohne Gemini/Wikipedia nötig) ----
  star: {
    key:'star', name:'Star', sci:'Sturnus vulgaris', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein schwätzender Mix aus Trillern, Pfiffen und nachgeahmten Geräuschen ist <b style="color:var(--ink)">Gesang</b> – Stare ahmen sogar Handyklingeltöne oder andere Vogelstimmen nach.',
    steckbrief:'Glänzend-schwarzes, gesprenkeltes Gefieder · 21 cm · bildet im Herbst riesige Schwärme.'
  },
  elster: {
    key:'elster', name:'Elster', sci:'Pica pica', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein hartes, schnelles „Schack-schack-schack" ist meist ein <b style="color:var(--ink)">Alarmruf</b> – etwa wenn eine Katze oder ein Greifvogel in der Nähe ist.',
    steckbrief:'Schwarz-weiß mit metallisch-grünem Schwanz · 44–46 cm · einer der intelligentesten Vögel überhaupt.'
  },
  rabenkraehe: {
    key:'rabenkraehe', name:'Rabenkrähe', sci:'Corvus corone', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Das tiefe, raue „Krah-krah-krah" ist ein <b style="color:var(--ink)">Kontaktruf</b> zwischen Artgenossen, oft auch zur Reviermarkierung.',
    steckbrief:'Komplett schwarz · 45–47 cm · sehr anpassungsfähig, in Stadt wie Wald häufig.'
  },
  eichelhaeher: {
    key:'eichelhaeher', name:'Eichelhäher', sci:'Garrulus glandarius', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein lautes, krächzendes „Rätsch" ist meist ein <b style="color:var(--ink)">Warnruf</b> – Eichelhäher schlagen oft als Erste Alarm, wenn ein Habicht oder Mensch den Wald betritt.',
    steckbrief:'Rotbraun mit blau-schwarz gebänderten Flügelfedern · 34–35 cm · vergräbt im Herbst tausende Eicheln als Wintervorrat.'
  },
  mauersegler: {
    key:'mauersegler', name:'Mauersegler', sci:'Apus apus', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Die schrillen „Sriii"-Rufe im rasanten Flug sind <b style="color:var(--ink)">Kontaktrufe</b> ganzer Gruppen, oft bei abendlichen Verfolgungsjagden zu hören.',
    steckbrief:'Fast nur in der Luft unterwegs – schläft sogar fliegend · 16–17 cm · in Deutschland nur von Mai bis August.'
  },
  rauchschwalbe: {
    key:'rauchschwalbe', name:'Rauchschwalbe', sci:'Hirundo rustica', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein zwitscherndes, schwatzendes Plaudern ist <b style="color:var(--ink)">Kontaktgesang</b> in der Kolonie, oft von Sitzwarten wie Stromleitungen aus.',
    steckbrief:'Rostrote Kehle, lange Schwanzspieße · 17–19 cm · brütet traditionell in Ställen und Scheunen.'
  },
  haussperling: {
    key:'haussperling', name:'Haussperling', sci:'Passer domesticus', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein simples, stetiges „Tschilp-tschilp" ist <b style="color:var(--ink)">Kontakt- und Reviergesang</b> – eher ein soziales Plappern als ausgefeilter Gesang.',
    steckbrief:'Männchen mit grauer Kappe und schwarzem Latz · 14–16 cm · lebt eng an menschlichen Siedlungen.'
  },
  gruenfink: {
    key:'gruenfink', name:'Grünfink', sci:'Chloris chloris', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein nasaler, gedehnter „Düüüh"-Ruf zwischen Trillern ist <b style="color:var(--ink)">Reviergesang</b>, oft im Singflug mit ausgebreiteten Flügeln vorgetragen.',
    steckbrief:'Olivgrün mit gelben Flügelbinden · 14–16 cm · häufiger Gast an Vogelfutterstellen.'
  },
  stieglitz: {
    key:'stieglitz', name:'Stieglitz', sci:'Carduelis carduelis', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein helles, klingelndes „Stiglit-stiglit" ist <b style="color:var(--ink)">Kontaktruf</b> im Schwarmflug – daher der Name.',
    steckbrief:'Rotes Gesicht, gelbe Flügelbinde · 12–13 cm · liebt Distel- und Wildkrautsamen.'
  },
  gimpel: {
    key:'gimpel', name:'Gimpel', sci:'Pyrrhula pyrrhula', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein weiches, melancholisches „Düü" ist <b style="color:var(--ink)">Kontaktruf</b> zwischen den meist paarweise auftretenden Vögeln.',
    steckbrief:'Männchen mit leuchtend roter Brust · 15–16 cm · scheu, hält sich oft im dichten Gebüsch verborgen.'
  },
  kleiber: {
    key:'kleiber', name:'Kleiber', sci:'Sitta europaea', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein lautes, schnell wiederholtes „Tüt-tüt-tüt" ist <b style="color:var(--ink)">Reviergesang</b> – der einzige heimische Vogel, der kopfüber an Stämmen herabläuft.',
    steckbrief:'Blaugrau mit rostrotem Bauch · 12–13 cm · verkleinert Baumhöhlen-Eingänge mit Lehm.'
  },
  blaumeise: {
    key:'blaumeise', name:'Blaumeise', sci:'Cyanistes caeruleus', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein heller Triller nach einleitendem „Tsi-tsi" ist <b style="color:var(--ink)">Reviergesang</b> des Männchens im Frühjahr.',
    steckbrief:'Blaue Kappe, gelbe Unterseite · 11–12 cm · häufigster Meisen-Gast am Nistkasten.'
  },
  wacholderdrossel: {
    key:'wacholderdrossel', name:'Wacholderdrossel', sci:'Turdus pilaris', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein raues, schnatterndes „Schack-schack-schack" im Flug ist <b style="color:var(--ink)">Kontaktruf</b> – Wacholderdrosseln ziehen oft in lockeren Trupps.',
    steckbrief:'Graukopf, rostbrauner Rücken · 25–26 cm · brütet in lockeren Kolonien, gemeinsam gegen Krähen verteidigt.'
  },
  singdrossel: {
    key:'singdrossel', name:'Singdrossel', sci:'Turdus philomelos', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Klare Strophen-Motive, jede meist zwei- bis dreimal wiederholt – ein kunstvoller <b style="color:var(--ink)">Reviergesang</b>.',
    steckbrief:'21–23 cm · gefleckte Brust · zerschlägt Schneckenhäuser an festen „Drosselschmieden".'
  },
  heckenbraunelle: {
    key:'heckenbraunelle', name:'Heckenbraunelle', sci:'Prunella modularis', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein hoher, hastiger Triller, meist unscheinbar aus einer Hecke vorgetragen – <b style="color:var(--ink)">Reviergesang</b> eines eher heimlichen Vogels.',
    steckbrief:'14 cm · graubraun, leicht mit dem Spatz verwechselt · lebt versteckt im Unterholz.'
  },
  gartenrotschwanz: {
    key:'gartenrotschwanz', name:'Gartenrotschwanz', sci:'Phoenicurus phoenicurus', rarity:'rare',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein kurzer, wehmütiger Gesang mit charakteristischem Schnörkel am Ende – <b style="color:var(--ink)">Reviergesang</b>, oft von erhöhter Warte aus.',
    steckbrief:'13–14 cm · oranges Brustgefieder, zitternder rostroter Schwanz · Zugvogel, Bestand rückläufig.'
  },
  hausrotschwanz: {
    key:'hausrotschwanz', name:'Hausrotschwanz', sci:'Phoenicurus ochruros', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein kratzig-knirschender Gesang, oft mit einem Geräusch wie „zerknülltes Papier" mittendrin – <b style="color:var(--ink)">Reviergesang</b>, gerne von Dächern aus.',
    steckbrief:'13–14 cm · rußschwarzes Gefieder, rostroter Schwanz · brütet oft an Gebäuden als Felsen-Ersatz.'
  },
  moenchsgrasmuecke: {
    key:'moenchsgrasmuecke', name:'Mönchsgrasmücke', sci:'Sylvia atricapilla', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein abwechslungsreicher, flötender Gesang, der oft in einer klaren, lauten Schlussstrophe gipfelt – <b style="color:var(--ink)">Reviergesang</b> aus dichtem Gebüsch.',
    steckbrief:'13–15 cm · Männchen mit schwarzer, Weibchen mit rostbrauner Kappe · einer der besten Sänger heimischer Wälder.'
  },
  zilpzalp: {
    key:'zilpzalp', name:'Zilpzalp', sci:'Phylloscopus collybita', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Der namensgebende, monotone „Zilp-zalp-zilp-zalp"-Gesang ist unverwechselbar – <b style="color:var(--ink)">Reviergesang</b>, einer der ersten Frühlingsboten.',
    steckbrief:'10–11 cm · unscheinbar olivgrün-grau · einer der häufigsten Brutvögel Mitteleuropas.'
  },
  waldkauz: {
    key:'waldkauz', name:'Waldkauz', sci:'Strix aluco', rarity:'rare',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Das gespenstische, gedehnte „Huuu-huuhuhuhuuuu" ist <b style="color:var(--ink)">Reviergesang</b> des Männchens; ein scharfes „Kewick" ist der Kontaktruf des Weibchens.',
    steckbrief:'37–39 cm · häufigste heimische Eule · rein nachtaktiv, daher selten zu sehen.'
  },
  maeusebussard: {
    key:'maeusebussard', name:'Mäusebussard', sci:'Buteo buteo', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein klagendes, katzenartiges „Hiääh" im Kreisflug ist <b style="color:var(--ink)">Reviermarkierung</b> – der häufigste Greifvogelruf am Tageshimmel.',
    steckbrief:'Spannweite über 1 m · häufigster Greifvogel Deutschlands · sitzt oft auffällig auf Zaunpfählen.'
  },
  turmfalke: {
    key:'turmfalke', name:'Turmfalke', sci:'Falco tinnunculus', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein schnelles, scharfes „Ki-ki-ki-ki" ist <b style="color:var(--ink)">Erregungs- oder Warnruf</b>, oft in der Nähe des Horsts zu hören.',
    steckbrief:'32–35 cm · bekannt für den „Rüttelflug" auf der Stelle bei der Mäusejagd · brütet auch an Gebäuden.'
  },
  ringeltaube: {
    key:'ringeltaube', name:'Ringeltaube', sci:'Columba palumbus', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein weiches, fünfsilbiges „Gru-Gru-Gruuu-Gru-Gru" ist <b style="color:var(--ink)">Reviergesang</b>, oft monoton wiederholt von einer Sitzwarte.',
    steckbrief:'40–42 cm · größte heimische Taube, weißer Halsfleck · häufig auch in Stadtparks.'
  },
  kuckuck: {
    key:'kuckuck', name:'Kuckuck', sci:'Cuculus canorus', rarity:'rare',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Der unverwechselbare, zweisilbige „Kuck-kuck"-Ruf ist <b style="color:var(--ink)">Reviergesang</b> des Männchens; Weibchen legen ihre Eier in fremde Nester.',
    steckbrief:'32–34 cm, ähnelt im Flug einem Sperber · Zugvogel, Bestand in Deutschland rückläufig.'
  },
  gruenspecht: {
    key:'gruenspecht', name:'Grünspecht', sci:'Picus viridis', rarity:'common',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein lautes, lachendes „Klü-klü-klü-klü" ist <b style="color:var(--ink)">Reviergesang</b> – daher der Beiname „Lachvogel"; trommelt selbst eher selten.',
    steckbrief:'31–33 cm · grünes Gefieder, rote Kappe · sucht am Boden gezielt nach Ameisen.'
  },
  schwarzspecht: {
    key:'schwarzspecht', name:'Schwarzspecht', sci:'Dryocopus martius', rarity:'rare',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein lautes, hallendes <b style="color:var(--ink)">Trommeln</b> über mehrere Sekunden markiert das Revier; ein durchdringendes „Kliöh" ist der Flugruf.',
    steckbrief:'45–48 cm · größter heimischer Specht, komplett schwarz mit roter Kappe · braucht alte, störungsarme Wälder.'
  },
  waldohreule: {
    key:'waldohreule', name:'Waldohreule', sci:'Asio otus', rarity:'rare',
    icon:BIRD, grad:GREEN, accent:'#a3e635',
    meaning:'Ein tiefes, monotones „Huu" in mehrsekündigen Abständen ist <b style="color:var(--ink)">Reviergesang</b> des Männchens – namensgebend für die langen Federohren.',
    steckbrief:'35–37 cm · auffällige Federohren · rastet tagsüber oft gesellig in dichten Nadelbäumen.'
  },
  wildschwein: {
    key:'wildschwein', name:'Wildschwein', sci:'Sus scrofa', rarity:'mammal',
    icon:DEER, grad:ROSE, accent:'#fb7185',
    meaning:'Grunzende, schmatzende Laute beim Wühlen im Boden sind normales <b style="color:var(--ink)">Kontaktverhalten</b> in der Rotte; ein scharfes Blasen ist ein Warnsignal.',
    steckbrief:'Häufigstes Schalenwild im Wald · dämmerungs- und nachtaktiv · Rotten bestehen meist aus Bachen mit Frischlingen.'
  },
  fuchs: {
    key:'fuchs', name:'Fuchs', sci:'Vulpes vulpes', rarity:'mammal',
    icon:DEER, grad:ROSE, accent:'#fb7185',
    meaning:'Heiseres Bellen oder gruselig klingendes Schreien in Winternächten ist <b style="color:var(--ink)">Paarungsruf</b> während der Ranzzeit (Dezember–Februar).',
    steckbrief:'Häufigstes Raubtier Mitteleuropas · dämmerungs- und nachtaktiv · sehr anpassungsfähig, auch in Städten verbreitet.'
  },
  dachs: {
    key:'dachs', name:'Dachs', sci:'Meles meles', rarity:'mammal',
    icon:DEER, grad:ROSE, accent:'#fb7185',
    meaning:'Dachse sind meist still; leises Schnaufen oder Knurren nahe am Bau ist <b style="color:var(--ink)">Warn- oder Drohverhalten</b>, eher selten zu hören.',
    steckbrief:'70–90 cm Körperlänge · nachtaktiv, lebt in großen unterirdischen Bauen ("Dachsburgen") · Allesfresser.'
  }
};

Object.assign(SPECIES, EXTRA_SPECIES);

export const SPECIES_LIST = Object.values(SPECIES);

// Stellt sicher, dass es zu einer erkannten Art einen Katalog-Eintrag gibt.
// Bekannte Arten (per wiss. Name) werden wiederverwendet; unbekannte (z. B. aus
// BirdNET) bekommen einen generischen Eintrag, damit Karte/Sammlung/Modal funktionieren.
export function ensureSpecies({ sci, name, rarity = 'common' }) {
  const scil = (sci || '').toLowerCase();
  const existing = SPECIES_LIST.find(s => s.sci.toLowerCase() === scil);
  if (existing) return existing.key;
  const key = 'x_' + (sci || name || 'unbekannt').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!SPECIES[key]) {
    SPECIES[key] = {
      key, name: name || sci || 'Unbekannt', sci: sci || '', rarity,
      icon: BIRD, grad: ['#0e5840', '#0a4733'], accent: '#a3e635',
      meaning: 'Über BirdNET am Ruf erkannt. Eine genaue Deutung des Rufs folgt mit der Gemini-Schicht.',
      steckbrief: 'Per BirdNET erkannte Art – noch kein ausführlicher Steckbrief hinterlegt.'
    };
    SPECIES_LIST.push(SPECIES[key]);
  }
  return key;
}
