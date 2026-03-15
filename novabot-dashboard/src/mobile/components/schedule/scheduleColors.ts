const COLORS = [
  { bg: 'bg-emerald-500/80', text: 'text-white' },
  { bg: 'bg-blue-500/80',    text: 'text-white' },
  { bg: 'bg-purple-500/80',  text: 'text-white' },
  { bg: 'bg-amber-500/80',   text: 'text-white' },
  { bg: 'bg-rose-500/80',    text: 'text-white' },
  { bg: 'bg-cyan-500/80',    text: 'text-white' },
];

export function getScheduleColor(index: number) {
  return COLORS[index % COLORS.length];
}
