type RangeOptions = {
  id: string;
  min: number;
  max: number;
  step: number;
  value: number;
  className?: string;
};

export function renderRange(options: RangeOptions) {
  const { id, min, max, step, value, className } = options;
  const classes = ["range", className].filter(Boolean).join(" ");
  return `<input id="${id}" class="${classes}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />`;
}

export function updateRangeFill(input: HTMLInputElement) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty("--range-progress", `${percent}%`);
}
