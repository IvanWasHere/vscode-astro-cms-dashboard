// Loads src/data/emergency.yaml (edited in the dashboard under Config → Emergency).
import { parse } from 'yaml';
import raw from '../data/emergency.yaml?raw';

export const emergency = parse(raw) as { title: string; numbers: { label: string; number: string }[] };
