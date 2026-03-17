function normalizeTransitContext(source = {}) {
  return {
    aspects: source.aspects || source.topAspects || source.top_aspects || [],
    retrogrades: source.retrogrades || [],
    moon: source.transits?.Moon || source.moon || null,
  };
}

function joinList(items = []) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function describeMoonTone(moon) {
  switch (moon?.element) {
    case 'Fire':
      return 'quicker, bolder, and more instinctive';
    case 'Earth':
      return 'steadier, more grounded, and easier to organize';
    case 'Air':
      return 'more social, mental, and conversation-driven';
    case 'Water':
      return 'more sensitive, reflective, and emotionally porous';
    default:
      return 'slightly more charged and emotionally noticeable';
  }
}

function buildWhyTodayFeelsDifferent(source) {
  const { aspects, retrogrades, moon } = normalizeTransitContext(source);
  const leadAspect = aspects[0];

  if (leadAspect) {
    const aspectLine = `${leadAspect.planet1} ${leadAspect.aspect} ${leadAspect.planet2}`;
    const retrogradeNames = retrogrades.map(item => item.planet);
    const retrogradeLine = retrogradeNames.length
      ? ` ${joinList(retrogradeNames)} retrograde also adds a more reflective undertone, so timing benefits from a little more care than speed.`
      : '';

    if (leadAspect.nature === 'harmonious') {
      return {
        title: 'There is more flow in the air',
        body: `${aspectLine} is softening the pace of the day, which can make conversations, timing, and emotional responses feel more natural than usual.${retrogradeLine}`,
      };
    }

    return {
      title: 'The atmosphere carries more weight',
      body: `${aspectLine} is adding a little pressure to the day, so emotions and decisions may feel more immediate than usual. A measured pace will reveal more than a rushed reaction.${retrogradeLine}`,
    };
  }

  if (retrogrades.length > 0) {
    const retrogradeNames = joinList(retrogrades.map(item => item.planet));
    return {
      title: 'The pace is more reflective',
      body: `${retrogradeNames} retrograde is slowing the emotional tempo of the day. Things may feel less linear than usual, but that slower rhythm can make room for better judgment.`,
    };
  }

  if (moon) {
    return {
      title: 'The Moon is setting the tone',
      body: `With the Moon moving through ${moon.sign}, today's atmosphere feels ${describeMoonTone(moon)}. That subtle shift can shape how quickly you trust, respond, and settle into your choices.`,
    };
  }

  return {
    title: 'The tone is quietly different',
    body: 'Even without a dramatic transit, the day carries a more noticeable inner rhythm. A little more presence than usual will help you hear what the moment is really asking for.',
  };
}

module.exports = { buildWhyTodayFeelsDifferent };
