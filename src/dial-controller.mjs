export function createDialStepper({ stepDegrees = 12, onStep = () => {} } = {}) {
  const threshold = Math.max(1, Math.abs(Number(stepDegrees) || 12));
  let accumulated = 0;
  return {
    push(delta) {
      const value = Number(delta);
      if (!Number.isFinite(value)) return 0;
      accumulated += value;
      const steps = Math.trunc(accumulated / threshold);
      if (!steps) return 0;
      accumulated -= steps * threshold;
      onStep(steps);
      return steps;
    },
    reset() {
      accumulated = 0;
    },
  };
}
