import type { SVGProps } from 'react';

export type IconName =
  | 'dashboard' | 'calendar' | 'briefcase' | 'finding' | 'check' | 'risk' | 'report' | 'history'
  | 'search' | 'bell' | 'chevron' | 'menu' | 'plus' | 'filter' | 'columns' | 'sparkles'
  | 'download' | 'print' | 'reset' | 'expand' | 'x' | 'more' | 'arrow' | 'user' | 'file';

const paths: Record<IconName, string[]> = {
  dashboard:['M3 3h7v7H3z','M14 3h7v7h-7z','M3 14h7v7H3z','M14 14h7v7h-7z'],
  calendar:['M6 2v4','M18 2v4','M3 9h18','M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z'],
  briefcase:['M9 7V4h6v3','M4 7h16a1 1 0 0 1 1 1v11H3V8a1 1 0 0 1 1-1z','M3 12h18'],
  finding:['M5 3h14v18H5z','M9 7h6','M9 11h6','M9 15h4'],
  check:['M4 12l5 5L20 6'],
  risk:['M12 3 2 21h20L12 3z','M12 9v4','M12 17h.01'],
  report:['M4 3h16v18H4z','M8 16v-4','M12 16V8','M16 16v-7'],
  history:['M3 12a9 9 0 1 0 3-6.7','M3 3v6h6','M12 7v5l3 2'],
  search:['M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z','M21 21l-4.3-4.3'],
  bell:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9','M10 21h4'],
  chevron:['M9 6l6 6-6 6'],
  menu:['M4 7h16','M4 12h16','M4 17h16'],
  plus:['M12 5v14','M5 12h14'],
  filter:['M4 5h16l-6 7v5l-4 2v-7L4 5z'],
  columns:['M4 4h16v16H4z','M12 4v16'],
  sparkles:['M12 3l1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3L12 3z','M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z'],
  download:['M12 3v12','M7 10l5 5 5-5','M5 21h14'],
  print:['M6 9V3h12v6','M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2','M6 14h12v7H6z'],
  reset:['M4 4v6h6','M4 10a8 8 0 1 0 2.3-5.7'],
  expand:['M8 3H3v5','M16 3h5v5','M8 21H3v-5','M16 21h5v-5'],
  x:['M6 6l12 12','M18 6 6 18'],
  more:['M5 12h.01','M12 12h.01','M19 12h.01'],
  arrow:['M5 12h14','M14 7l5 5-5 5'],
  user:['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z','M4 21a8 8 0 0 1 16 0'],
  file:['M6 2h8l4 4v16H6z','M14 2v5h5'],
};

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {paths[name].map((d,i)=><path key={i} d={d}/>)}
  </svg>;
}
