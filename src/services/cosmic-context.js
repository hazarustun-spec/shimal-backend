const { toTR } = require('../utils/zodiac-tr');

function normalizeTransitContext(source = {}) {
  return {
    aspects: source.aspects || source.topAspects || source.top_aspects || [],
    retrogrades: source.retrogrades || [],
    moon: source.transits?.Moon || source.moon || null,
  };
}

const planetTR = (p) => ({
  Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars',
  Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton',
  'Transit Sun':'Transit Güneş', 'Transit Moon':'Transit Ay', 'Transit Mercury':'Transit Merkür',
  'Transit Venus':'Transit Venüs', 'Transit Mars':'Transit Mars', 'Transit Jupiter':'Transit Jüpiter',
  'Transit Saturn':'Transit Satürn', 'Transit Uranus':'Transit Uranüs', 'Transit Neptune':'Transit Neptün',
  'Transit Pluto':'Transit Plüton', 'Natal Sun':'Natal Güneş', 'Natal Moon':'Natal Ay',
  'Natal Mercury':'Natal Merkür', 'Natal Venus':'Natal Venüs', 'Natal Mars':'Natal Mars',
  'Natal Jupiter':'Natal Jüpiter', 'Natal Saturn':'Natal Satürn', 'Natal Uranus':'Natal Uranüs',
  'Natal Neptune':'Natal Neptün', 'Natal Pluto':'Natal Plüton'
}[p] || p);

const aspectTR = (a) => ({
  conjunction:'Kavuşum', opposition:'Karşıt', trine:'Üçgen', square:'Kare', sextile:'Altıgen',
  Conjunction:'Kavuşum', Opposition:'Karşıt', Trine:'Üçgen', Square:'Kare', Sextile:'Altıgen'
}[a] || a);

function joinList(items = []) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ve ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ve ${items[items.length - 1]}`;
}

function describeMoonTone(moon) {
  switch (moon?.element) {
    case 'Fire':
      return 'daha hızlı, cesaretli ve içgüdüsel';
    case 'Earth':
      return 'daha sakin, ayakları yere basan ve organize';
    case 'Air':
      return 'daha sosyal, zihinsel ve iletişime açık';
    case 'Water':
      return 'daha hassas, düşünceli ve duygusal olarak geçirgen';
    default:
      return 'biraz daha yoğun ve duygusal olarak hissedilir';
  }
}

function buildWhyTodayFeelsDifferent(source) {
  const { aspects, retrogrades, moon } = normalizeTransitContext(source);
  const leadAspect = aspects[0];

  if (leadAspect) {
    const p1 = planetTR(leadAspect.planet1);
    const p2 = planetTR(leadAspect.planet2);
    const asp = aspectTR(leadAspect.aspect);
    const aspectLine = `${p1} ${asp} ${p2}`;
    const retrogradeNames = retrogrades.map(item => planetTR(item.planet));
    const retrogradeLine = retrogradeNames.length
      ? ` ${joinList(retrogradeNames)} retrograd da daha düşünceli bir alt ton ekliyor — hız yerine zamanlama bugün daha önemli.`
      : '';

    if (leadAspect.nature === 'harmonious') {
      return {
        title: 'Bugün havada bir akış var',
        body: `${aspectLine} günün ritmini yumuşatıyor. Konuşmalar, zamanlama ve duygusal tepkiler normalden daha doğal hissedebilir.${retrogradeLine}`,
      };
    }

    return {
      title: 'Atmosfer bugün daha ağır',
      body: `${aspectLine} güne biraz baskı ekliyor. Duygular ve kararlar normalden daha acil hissedebilir. Ölçülü bir tempo, acele bir tepkiden daha fazlasını ortaya çıkaracak.${retrogradeLine}`,
    };
  }

  if (retrogrades.length > 0) {
    const retrogradeNames = joinList(retrogrades.map(item => planetTR(item.planet)));
    return {
      title: 'Tempo daha düşünceli',
      body: `${retrogradeNames} retrograd günün duygusal temposunu yavaşlatıyor. Her şey normalden daha az çizgisel hissedebilir ama bu yavaş ritim daha iyi kararlar için alan açabilir.`,
    };
  }

  if (moon) {
    const moonSignTR = toTR(moon.sign);
    return {
      title: 'Ay bugün tonu belirliyor',
      body: `Ay ${moonSignTR} burcunda ilerlerken bugünün atmosferi ${describeMoonTone(moon)} hissettiriyor. Bu ince değişim güvenme, tepki verme ve kararlarına yerleşme hızını etkileyebilir.`,
    };
  }

  return {
    title: 'Bugün bir şeyler farklı',
    body: 'Dramatik bir transit olmasa bile gün normalden daha belirgin bir iç ritim taşıyor. Biraz daha fazla farkındalık, anın senden gerçekte ne istediğini duymanı sağlayacak.',
  };
}

module.exports = { buildWhyTodayFeelsDifferent };
