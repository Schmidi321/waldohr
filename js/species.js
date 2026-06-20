// Arten-Katalog — zentrale Datenquelle für Erkennung & UI.
// rarity: 'common' | 'rare' | 'mammal'  (steuert Farbe/Badge)

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
  }
};

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
