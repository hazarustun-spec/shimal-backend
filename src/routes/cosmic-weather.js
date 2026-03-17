'use strict';

const { buildCosmicWeather } = require('../services/cosmic-weather-builder');
const { writeJson, internalError } = require('../utils/http');

async function handleCosmicWeather(_req, res) {
  try {
    writeJson(res, 200, buildCosmicWeather());
  } catch (error) {
    internalError(res, error, '[CosmicWeather] Error:', 'Failed to calculate cosmic weather.');
  }
}

module.exports = [
  ['GET', /^\/api\/cosmic-weather$/, handleCosmicWeather],
];
