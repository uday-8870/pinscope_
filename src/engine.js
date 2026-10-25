'use strict';

/**
 * PinScope Core Engineering Model & Layout Intelligence Engine
 */

const {
  MODEL_WEIGHTS,
  PACKAGE_PRESETS,
  LAYOUT_PROJECTS,
  SEMICONDUCTOR_FAMILIES
} = require('./dataset');

const EPSILON = 1e-6;

function logNormalizedDistance(a, b, floor = 0.05) {
  const safeA = Math.max(Number(a) || floor, floor);
  const safeB = Math.max(Number(b) || floor, floor);
  return Math.abs(Math.log(safeA / safeB));
}

function distanceToScore(weightedDistance) {
  const clamped = Math.max(0, Number(weightedDistance) || 0);
  return Number((100 * Math.exp(-1.15 * clamped)).toFixed(2));
}

function classifyPackage(payload = {}) {
  const presetId = payload.presetId || null;
  const imageMeta = payload.imageMeta || null;
  const overrides = payload.overrides || {};

  let matchedPreset = null;
  if (presetId) {
    matchedPreset = PACKAGE_PRESETS.find((p) => p.id === presetId) || null;
  }

  if (!matchedPreset && imageMeta && imageMeta.fileName) {
    const lower = String(imageMeta.fileName).toLowerCase();
    matchedPreset = PACKAGE_PRESETS.find((p) => {
      return (
        lower.includes(p.id.split('-')[0]) ||
        lower.includes(p.packageFamily.toLowerCase()) ||
        lower.includes(p.partReference.toLowerCase().split(' ')[0])
      );
    });
  }

  if (!matchedPreset) {
    matchedPreset = PACKAGE_PRESETS[0];
  }

  const bodyLengthMm = Number(overrides.bodyLengthMm) || matchedPreset.bodyLengthMm;
  const bodyWidthMm = Number(overrides.bodyWidthMm) || matchedPreset.bodyWidthMm;
  const pitchMm = Number(overrides.pitchMm) || matchedPreset.pitchMm;
  const ratedCurrentA = Number(overrides.ratedCurrentA) || matchedPreset.ratedCurrentA;
  const ratedVoltageV = Number(overrides.ratedVoltageV) || matchedPreset.ratedVoltageV;

  const evidence = matchedPreset.evidence.map((ev) => ({ ...ev }));
  if (imageMeta && imageMeta.fileName) {
    const contrastScore = typeof imageMeta.contrastScore === 'number' ? imageMeta.contrastScore : 0.92;
    const edgeDensity = typeof imageMeta.edgeDensity === 'number' ? imageMeta.edgeDensity : 0.90;
    evidence.unshift({
      id: 'ev-img-upload',
      category: 'Uploaded Image Inspection',
      title: `Raster Footprint Analysis (${imageMeta.fileName})`,
      confidence: Number(Math.min(0.99, Math.max(0.78, (contrastScore + edgeDensity) / 2)).toFixed(2)),
      bbox: { x: 0.05, y: 0.05, w: 0.90, h: 0.90 },
      metric: `${imageMeta.width || 600}×${imageMeta.height || 600} px | Contrast ${(contrastScore * 100).toFixed(0)}%`,
      rationale: `Extracted package boundary aspect ${(bodyWidthMm / bodyLengthMm).toFixed(2)}:1 and matched terminal lead profile against ${matchedPreset.packageFamily} reference template.`
    });
  }

  const pins = matchedPreset.pins.map((p) => ({ ...p, verified: Boolean(p.verified) }));
  const netCounts = {
    powerIn: pins.filter((p) => p.type === 'POWER_IN' || p.type === 'POWER_OUT').length,
    switchNode: pins.filter((p) => p.type === 'SWITCH').length,
    powerGnd: pins.filter((p) => p.type === 'GND_PWR' || p.type === 'THERMAL_PAD').length,
    kelvinSense: pins.filter((p) => p.type === 'SENSE' || p.type === 'GND_ANA').length,
    controlGate: pins.filter((p) => ['GATE_DRV', 'CONTROL', 'CLOCK', 'ANALOG', 'BIAS', 'STATUS'].includes(p.type)).length
  };

  const drcFindings = [];
  if (netCounts.kelvinSense > 0) {
    drcFindings.push({
      severity: 'PASS',
      code: 'DRC-KELVIN-OK',
      pins: pins.filter((p) => p.type === 'SENSE' || p.type === 'GND_ANA').map((p) => p.pin),
      message: `Dedicated Kelvin sense / quiet reference pins identified (${netCounts.kelvinSense} pins). Route differentially away from SW copper pour.`
    });
  }
  if (matchedPreset.exposedPad && matchedPreset.exposedPad.present) {
    const epadArea = Number((matchedPreset.exposedPad.lengthMm * matchedPreset.exposedPad.widthMm).toFixed(2));
    const recommendedVias = Math.max(4, Math.round(epadArea * 2.4));
    drcFindings.push({
      severity: 'INFO',
      code: 'DRC-THERMAL-VIA',
      pins: pins.filter((p) => p.type === 'THERMAL_PAD').map((p) => p.pin),
      message: `Exposed thermal pad (${epadArea} mm² on net ${matchedPreset.exposedPad.net}) supports ~${recommendedVias}x 0.20mm thermal vias.`
    });
  }

  const overallConfidence = Number(
    (evidence.reduce((acc, item) => acc + item.confidence, 0) / Math.max(1, evidence.length)).toFixed(3)
  );

  return {
    presetId: matchedPreset.id,
    name: matchedPreset.name,
    partReference: matchedPreset.partReference,
    packageFamily: matchedPreset.packageFamily,
    interconnect: matchedPreset.interconnect,
    topology: matchedPreset.topology,
    dimensions: {
      bodyLengthMm,
      bodyWidthMm,
      bodyHeightMm: matchedPreset.bodyHeightMm,
      footprintAreaMm2: Number((bodyLengthMm * bodyWidthMm).toFixed(2)),
      pitchMm,
      pinCount: matchedPreset.pinCount
    },
    exposedPad: matchedPreset.exposedPad,
    electrical: {
      ratedCurrentA,
      ratedVoltageV,
      estimatedLoopInductanceNh: matchedPreset.estimatedLoopInductanceNh
    },
    datasheetUrl: matchedPreset.datasheetUrl,
    description: matchedPreset.description,
    overallConfidence,
    evidence,
    netCounts,
    drcFindings,
    pins
  };
}

function selectLayouts(query = {}) {
  const targetTopology = query.topology && query.topology !== 'ANY' ? String(query.topology) : null;
  const targetInterconnect = query.interconnect && query.interconnect !== 'ANY' ? String(query.interconnect) : null;

  const targetCurrentA = Math.max(0.1, Number(query.currentA) || 25);
  const targetPinCount = Math.max(2, Number(query.pinCount) || 24);
  const targetLengthMm = Math.max(0.5, Number(query.lengthMm) || 4.0);
  const targetWidthMm = Math.max(0.5, Number(query.widthMm) || 4.0);
  const targetPitchMm = Math.max(0.1, Number(query.pitchMm) || 0.5);
  const targetAreaMm2 = targetLengthMm * targetWidthMm;
  const targetAspect = Math.max(targetLengthMm, targetWidthMm) / Math.min(targetLengthMm, targetWidthMm);
  const limit = Math.max(1, Math.min(20, Number(query.limit) || 6));

  const weights = { ...MODEL_WEIGHTS };
  const combinedCurrentPinoutWeight = Number((weights.current + weights.pinCount).toFixed(2));

  const exactMatches = LAYOUT_PROJECTS.filter((proj) => {
    const topoMatch = !targetTopology || proj.topology.toLowerCase() === targetTopology.toLowerCase();
    const interMatch = !targetInterconnect || proj.interconnect.toLowerCase() === targetInterconnect.toLowerCase();
    return topoMatch && interMatch;
  });

  const topologyOnlyMatches = LAYOUT_PROJECTS.filter((proj) => {
    return !targetTopology || proj.topology.toLowerCase() === targetTopology.toLowerCase();
  });

  let filterMode = 'EXACT_TOPOLOGY_AND_INTERCONNECT';
  let candidatePool = exactMatches;

  if (candidatePool.length === 0 && topologyOnlyMatches.length > 0) {
    filterMode = 'TOPOLOGY_MATCH_INTERCONNECT_RELAXED';
    candidatePool = topologyOnlyMatches;
  } else if (candidatePool.length === 0) {
    filterMode = 'GLOBAL_FALLBACK_NO_EXACT_FILTER';
    candidatePool = LAYOUT_PROJECTS;
  } else if (!targetTopology && !targetInterconnect) {
    filterMode = 'UNFILTERED_ALL_PROJECTS';
  }

  const poolToScore = Boolean(query.includeFallbackCandidates) ? LAYOUT_PROJECTS : candidatePool;

  const scored = poolToScore.map((proj) => {
    const projAreaMm2 = proj.lengthMm * proj.widthMm;
    const projAspect = Math.max(proj.lengthMm, proj.widthMm) / Math.min(proj.lengthMm, proj.widthMm);

    const dCurrent = logNormalizedDistance(targetCurrentA, proj.currentA, 0.1);
    const dPinCount = logNormalizedDistance(targetPinCount, proj.pinCount, 1.0);
    const dArea = logNormalizedDistance(targetAreaMm2, projAreaMm2, 0.2);
    const dPitch = logNormalizedDistance(targetPitchMm, proj.pitchMm, 0.05);
    const dGeometry = logNormalizedDistance(targetAspect, projAspect, 0.1);

    const weightedDistance =
      weights.current * dCurrent +
      weights.pinCount * dPinCount +
      weights.area * dArea +
      weights.pitch * dPitch +
      weights.geometry * dGeometry;

    const topologyMatch = !targetTopology || proj.topology.toLowerCase() === targetTopology.toLowerCase();
    const interconnectMatch = !targetInterconnect || proj.interconnect.toLowerCase() === targetInterconnect.toLowerCase();
    const filterPenalty = (topologyMatch ? 0 : 0.25) + (interconnectMatch ? 0 : 0.15);
    const matchScore = distanceToScore(weightedDistance + filterPenalty);

    const adaptations = [
      `Validated ${proj.copperWeightOz}oz, ${proj.pcbLayers}-layer stackup reference for ${targetCurrentA}A operation.`,
      `Escape fanout matched against ${proj.pinCount}-pin (${proj.packageCode}) template.`
    ];

    return {
      ...proj,
      footprintAreaMm2: Number(projAreaMm2.toFixed(2)),
      topologyMatch,
      interconnectMatch,
      matchScore,
      weightedDistance: Number(weightedDistance.toFixed(4)),
      distances: {
        current: Number(dCurrent.toFixed(4)),
        pinCount: Number(dPinCount.toFixed(4)),
        area: Number(dArea.toFixed(4)),
        pitch: Number(dPitch.toFixed(4)),
        geometry: Number(dGeometry.toFixed(4))
      },
      weightedContributions: {
        current: Number((weights.current * dCurrent).toFixed(4)),
        pinCount: Number((weights.pinCount * dPinCount).toFixed(4)),
        area: Number((weights.area * dArea).toFixed(4)),
        pitch: Number((weights.pitch * dPitch).toFixed(4)),
        geometry: Number((weights.geometry * dGeometry).toFixed(4))
      },
      adaptations
    };
  });

  scored.sort((a, b) => {
    if (a.topologyMatch !== b.topologyMatch) return a.topologyMatch ? -1 : 1;
    if (a.interconnectMatch !== b.interconnectMatch) return a.interconnectMatch ? -1 : 1;
    return a.weightedDistance - b.weightedDistance;
  });

  return {
    query: {
      topology: targetTopology || 'ANY',
      interconnect: targetInterconnect || 'ANY',
      currentA: targetCurrentA,
      pinCount: targetPinCount,
      lengthMm: targetLengthMm,
      widthMm: targetWidthMm,
      areaMm2: Number(targetAreaMm2.toFixed(2)),
      pitchMm: targetPitchMm
    },
    filterMode,
    totalCatalogSize: LAYOUT_PROJECTS.length,
    matchedPoolSize: candidatePool.length,
    weights,
    combinedCurrentPinoutWeight,
    recommendations: scored.slice(0, limit)
  };
}

function fitPowerCurve(samples = []) {
  const valid = samples.filter((s) => Number(s.areaMm2) > 0 && Number(s.currentA) > 0);
  if (valid.length < 2) {
    throw new Error('At least 2 positive (areaMm2, currentA) sample points are required.');
  }

  const n = valid.length;
  const xs = valid.map((s) => Math.log(Number(s.areaMm2)));
  const ys = valid.map((s) => Math.log(Number(s.currentA)));

  const meanX = xs.reduce((acc, v) => acc + v, 0) / n;
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    den += dx * dx;
  }

  const b = den > EPSILON ? num / den : 1.0;
  const lnA = meanY - b * meanX;
  const a = Math.exp(lnA);

  let ssTot = 0;
  let ssRes = 0;
  const samplesWithFit = valid.map((s, idx) => {
    const predictedCurrentA = a * Math.pow(Number(s.areaMm2), b);
    const predictedAreaMm2 = Math.pow(Number(s.currentA) / a, 1 / b);
    const errPct = ((predictedCurrentA - s.currentA) / s.currentA) * 100;
    const yHat = lnA + b * xs[idx];
    ssTot += Math.pow(ys[idx] - meanY, 2);
    ssRes += Math.pow(ys[idx] - yHat, 2);
    return {
      ...s,
      predictedCurrentA: Number(predictedCurrentA.toFixed(2)),
      predictedAreaMm2: Number(predictedAreaMm2.toFixed(2)),
      errorPct: Number(errPct.toFixed(2))
    };
  });

  const rSquared = ssTot > EPSILON ? Math.max(0, 1 - ssRes / ssTot) : 1.0;

  return {
    a: Number(a.toFixed(4)),
    b: Number(b.toFixed(4)),
    rSquared: Number(rSquared.toFixed(4)),
    sampleCount: n,
    formulaText: `I = ${a.toFixed(3)} × area^${b.toFixed(3)}`,
    inverseFormulaText: `area = (I / ${a.toFixed(3)})^(1 / ${b.toFixed(3)})`,
    samplesWithFit
  };
}

function estimateGrossDiePerWafer(waferDiameterMm, totalDieAreaMm2, scribeStreetUm = 75) {
  const edgeExclusionMm = 3.0;
  const rEff = waferDiameterMm / 2 - edgeExclusionMm;
  if (rEff <= 0 || totalDieAreaMm2 <= 0) return 0;

  const dieSideMm = Math.sqrt(totalDieAreaMm2) + scribeStreetUm / 1000;
  const effDieArea = dieSideMm * dieSideMm;
  const waferArea = Math.PI * rEff * rEff;
  const perimeterCorrection = (Math.PI * waferDiameterMm) / Math.sqrt(2 * effDieArea);
  return Math.max(1, Math.floor(waferArea / effDieArea - perimeterCorrection));
}

function sizeDie(payload = {}) {
  const familyId = payload.familyId || SEMICONDUCTOR_FAMILIES[0].id;
  const family = SEMICONDUCTOR_FAMILIES.find((f) => f.id === familyId) || SEMICONDUCTOR_FAMILIES[0];
  const customSamples = Array.isArray(payload.customSamples) ? payload.customSamples : [];
  const mergedSamples = [...family.samples, ...customSamples];

  const fit = fitPowerCurve(mergedSamples);
  const mode = payload.mode === 'areaToCurrent' ? 'areaToCurrent' : 'currentToArea';
  let targetCurrentA = Number(payload.targetCurrentA) || 25;
  let estimatedTotalAreaMm2 = 0;

  if (mode === 'areaToCurrent') {
    estimatedTotalAreaMm2 = Math.max(0.2, Number(payload.targetAreaMm2) || 5.0);
    targetCurrentA = fit.a * Math.pow(estimatedTotalAreaMm2, fit.b);
  } else {
    targetCurrentA = Math.max(0.1, targetCurrentA);
    estimatedTotalAreaMm2 = Math.pow(targetCurrentA / fit.a, 1 / fit.b);
  }

  const padOverheadMm2 = Math.min(estimatedTotalAreaMm2 * 0.45, family.padRingOverheadMm2);
  const activeFetAreaMm2 = Math.max(0.15, estimatedTotalAreaMm2 - padOverheadMm2);
  const estimatedRonMohm = family.specificRonMohmMm2 / activeFetAreaMm2;

  const rmsCurrentA = targetCurrentA * 0.65;
  const conductionLossW = Math.pow(rmsCurrentA, 2) * (estimatedRonMohm / 1000);
  const totalPowerLossW = conductionLossW * 1.28;

  const estThetaJaCw = family.baseThetaJaCwMm2 / Math.pow(estimatedTotalAreaMm2, 0.42);
  const ambientC = Number(payload.ambientTempC) || family.ambientTempC;
  const estimatedTjC = ambientC + totalPowerLossW * estThetaJaCw;
  const thermalMarginC = family.maxTjC - estimatedTjC;

  const aspectRatio = Math.max(0.5, Math.min(3.0, Number(payload.aspectRatio) || 1.0));
  const dieWidthMm = Math.sqrt(estimatedTotalAreaMm2 / aspectRatio);
  const dieLengthMm = dieWidthMm * aspectRatio;
  const gdpw = estimateGrossDiePerWafer(family.waferDiameterMm, estimatedTotalAreaMm2, family.scribeStreetUm);

  const areas = mergedSamples.map((s) => Number(s.areaMm2));
  const minArea = Math.max(0.2, Math.min(...areas, estimatedTotalAreaMm2) * 0.7);
  const maxArea = Math.max(...areas, estimatedTotalAreaMm2) * 1.25;
  const curvePoints = [];
  for (let i = 0; i <= 40; i++) {
    const areaVal = minArea + (i / 40) * (maxArea - minArea);
    const currVal = fit.a * Math.pow(areaVal, fit.b);
    curvePoints.push({
      areaMm2: Number(areaVal.toFixed(3)),
      currentA: Number(currVal.toFixed(3)),
      lowerBandA: Number((currVal * 0.91).toFixed(3)),
      upperBandA: Number((currVal * 1.09).toFixed(3))
    });
  }

  const crossFamilyComparison = SEMICONDUCTOR_FAMILIES.map((fam) => {
    const famFit = fitPowerCurve(fam.samples);
    const reqArea = Math.pow(targetCurrentA / famFit.a, 1 / famFit.b);
    const actArea = Math.max(0.15, reqArea - Math.min(reqArea * 0.45, fam.padRingOverheadMm2));
    const ron = fam.specificRonMohmMm2 / actArea;
    return {
      familyId: fam.id,
      name: fam.name,
      voltageClassV: fam.voltageClassV,
      a: famFit.a,
      b: famFit.b,
      rSquared: famFit.rSquared,
      requiredAreaMm2: Number(reqArea.toFixed(2)),
      estimatedRonMohm: Number(ron.toFixed(2)),
      gdpw: estimateGrossDiePerWafer(fam.waferDiameterMm, reqArea, fam.scribeStreetUm)
    };
  });

  return {
    familyId: family.id,
    familyName: family.name,
    processNode: family.processNode,
    voltageClassV: family.voltageClassV,
    description: family.description,
    mode,
    regression: fit,
    estimate: {
      targetCurrentA: Number(targetCurrentA.toFixed(2)),
      totalDieAreaMm2: Number(estimatedTotalAreaMm2.toFixed(3)),
      activeFetAreaMm2: Number(activeFetAreaMm2.toFixed(3)),
      padRingOverheadMm2: Number(padOverheadMm2.toFixed(3)),
      activeAreaPct: Number(((activeFetAreaMm2 / estimatedTotalAreaMm2) * 100).toFixed(1)),
      dieLengthMm: Number(dieLengthMm.toFixed(2)),
      dieWidthMm: Number(dieWidthMm.toFixed(2)),
      estimatedRonMohm: Number(estimatedRonMohm.toFixed(2)),
      conductionLossW: Number(conductionLossW.toFixed(2)),
      totalPowerLossW: Number(totalPowerLossW.toFixed(2)),
      estimatedThetaJaCw: Number(estThetaJaCw.toFixed(1)),
      ambientTempC: ambientC,
      estimatedTjC: Number(estimatedTjC.toFixed(1)),
      maxTjC: family.maxTjC,
      thermalMarginC: Number(thermalMarginC.toFixed(1)),
      thermalStatus: thermalMarginC >= 15 ? 'SAFE' : thermalMarginC >= 0 ? 'MARGINAL' : 'EXCEEDS_TJ_MAX',
      waferDiameterMm: family.waferDiameterMm,
      grossDiePerWafer: gdpw
    },
    curvePoints,
    crossFamilyComparison
  };
}

function generateSignoffReport(state = {}) {
  const classification = classifyPackage(state.classify || {});
  const selection = selectLayouts(state.select || {
    topology: classification.topology,
    interconnect: classification.interconnect,
    currentA: classification.electrical.ratedCurrentA,
    pinCount: classification.dimensions.pinCount,
    lengthMm: classification.dimensions.bodyLengthMm,
    widthMm: classification.dimensions.bodyWidthMm,
    pitchMm: classification.dimensions.pitchMm
  });
  const sizing = sizeDie(state.size || {
    targetCurrentA: classification.electrical.ratedCurrentA
  });

  const topCandidate = selection.recommendations[0];
  const timestamp = new Date().toISOString();

  const markdown = [
    `# PinScope Layout Intelligence — Engineering Signoff Dossier`,
    `**Generated:** ${timestamp}`,
    `**Package Target:** ${classification.name} (${classification.partReference})`,
    `- **Combined Current + Pinout Priority:** 54%`,
    `- **Top Recommended Layout:** ${topCandidate.id} (${topCandidate.partNumber}) — Score ${topCandidate.matchScore}%`,
    `- **Fitted Power Law:** \`${sizing.regression.formulaText}\` -> ${sizing.estimate.totalDieAreaMm2} mm²`
  ].join('\n');

  return {
    timestamp,
    classification,
    selection,
    sizing,
    markdown
  };
}

module.exports = {
  MODEL_WEIGHTS,
  logNormalizedDistance,
  distanceToScore,
  classifyPackage,
  selectLayouts,
  fitPowerCurve,
  estimateGrossDiePerWafer,
  sizeDie,
  generateSignoffReport
};
