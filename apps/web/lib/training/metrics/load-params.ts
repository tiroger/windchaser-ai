/**
 * Fitted coefficients for the Garmin-style exercise load, load focus and
 * VO2max. One module so a refit touches one file.
 *
 * How they were fitted. Targets are the rider's own Garmin numbers: each
 * activity's `activityTrainingLoad` (Firstbeat peak EPOC, ml/kg) and
 * `trainingEffectLabel`, from the Garmin Personal API, matched to Strava
 * activities by start time (±3 min). Features are the Strava summary fields
 * this app stores, 2024 onwards. Every model was trained on the oldest 80% and
 * validated on the newest 20% by date. The data stays out of the repository
 * because it is personal; only coefficients live here.
 *
 * The second-by-second model runs in the sync worker
 * (services/training_sync/exercise_load.py) and arrives as
 * `exercise_load` on the streams index; the models below are its fallbacks.
 * Heart rate is expressed as a fraction of reserve between resting and maximum
 * heart rate: athlete settings where set, otherwise the 99th percentile of
 * activity maxima (as the Performance page derives it), otherwise these
 * fallbacks. The fit used the rider's measured anchors, which stay out of the
 * repository; setting them in athlete settings reproduces it exactly. Both
 * sides apply the same rule.
 */

export const HEART_RATE_ANCHORS = { restingHr: 49, maxHr: 190 };

/**
 * Summary model, from average and max heart rate (437 activities):
 *
 *   ln(load) = b0 + b1 ln(min) + b2 x + b3 xMax + b4 x² + b5 P + b6 P ln(min)
 *   load    *= smear
 *
 * x and xMax are average and max heart rate as a fraction of reserve, P is 1
 * for pickleball, and smear is Duan's retransformation factor. Hold-out
 * (88): MAE 17.3, MAPE 36%, R² 0.83, bias +6.0. Rides MAE 16.9, Zwift 15.4,
 * pickleball 20.1.
 */
export const SUMMARY_MODEL = {
  intercept: -1.6503,
  logMinutes: 0.5572,
  reserve: 1.446,
  maxReserve: 2.9366,
  reserveSquared: 1.6502,
  pickleball: 1.0021,
  pickleballLogMinutes: -0.2498,
  smear: 1.0382,
};

/**
 * Power model, for rides without heart rate (378 rides with power):
 *
 *   load = smear · e^b0 · TSS^b1,  TSS = hours · (W / referenceWatts)² · 100
 *
 * W is normalized power (else average power). referenceWatts is the FTP the
 * rider's Garmin used over the period, fixed so the model does not move when
 * the app's own FTP estimate does. Hold-out (76): MAE 17.1, MAPE 39%, R² 0.85,
 * bias +6.2; Zwift MAE 15.5.
 */
export const POWER_MODEL = {
  referenceWatts: 210,
  intercept: 1.5031,
  logTss: 0.731,
  smear: 1.1243,
};

/**
 * Load focus. Garmin files each activity under its primary training benefit:
 * recovery and base are low aerobic; tempo, threshold and VO2max are high
 * aerobic; anaerobic capacity and speed are anaerobic. A multinomial logistic
 * on [1, x, xMax, ln(min), P] predicts that category (weights per category,
 * low aerobic is the reference). Hold-out accuracy 85% against 81% for always
 * guessing low aerobic; predicted four-week load shares 60/34/6% against
 * Garmin's 66/32/3%. Without heart rate, a ride at intensity (W /
 * referenceWatts) of 0.77 or more is high aerobic (hold-out accuracy 84%).
 */
export const FOCUS_MODEL = {
  weights: {
    lowAerobic: [0, 0, 0, 0, 0],
    highAerobic: [-26.487, 18.572, 18.818, -0.342, -2.555],
    anaerobic: [-13.721, -7.032, 12.199, 0.776, 4.946],
  },
  powerHighAerobic: 0.77,
  /** A four-week split is "<category> focus" once one category holds this share. */
  dominantShare: 0.6,
};

/** Garmin: acute is a weighted sum of recent EPOC; chronic the four-week equivalent. */
export const LOAD_WINDOWS = { acuteDays: 7, chronicDays: 28, focusDays: 28 };

/** Garmin's load-ratio bands: low < 0.8 ≤ optimal < 1.5 ≤ high < 2.0 ≤ very high. */
export const LOAD_RATIO = { optimalFrom: 0.8, highFrom: 1.5, veryHighFrom: 2.0 };

/**
 * VO2max: the median of per-ride estimates over a trailing 42 days, at least
 * three rides. Against Garmin's own per-ride cycling VO2max (in the FIT
 * files), the newest 20% (20 rides) scored MAE 1.2 ml/kg/min, bias -0.3, with
 * no offset applied (offset stays 0: the ACSM equation is used as published).
 */
export const VO2MAX_MODEL = {
  windowDays: 42,
  minRides: 3,
  offset: 0,
  bestPowerDays: 90,
  /** No ride estimate this recently and the card shows the trend without a current value. */
  staleAfterDays: 60,
};
