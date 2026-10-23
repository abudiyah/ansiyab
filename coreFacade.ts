export * from '@ansiyab/core';
import { overpass, tomtom } from '@ansiyab/core';

export const normalizeArabicNameSafe = (s: string) => overpass.normalizeArabicName(s);
export const pollingIntervalFor = (quota: number, perCycle: number) => tomtom.pollingIntervalForBudget(quota, perCycle);
