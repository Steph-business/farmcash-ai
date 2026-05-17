/**
 * Blacklist des PIN les plus communs / triviaux à brute-forcer.
 * Source : top des PIN exposés dans les leaks publics (Bonneau et al.).
 */
const COMMON_WEAK_PINS = new Set<string>([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '1212', '2121', '1230', '0123', '9876', '6789',
  '1004', '2000', '2001', '1010', '1313', '5683', '7777',
  '000000', '111111', '123456', '654321', '121212', '696969', '112233',
]);

const isAllSameDigits = (pin: string): boolean => /^(\d)\1+$/.test(pin);
const isSequential = (pin: string): boolean => {
  for (let i = 1; i < pin.length; i++) {
    const diff = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (diff !== 1 && diff !== -1) return false;
  }
  return true;
};

export const isWeakPin = (pin: string): boolean => {
  if (!pin || !/^\d{4,6}$/.test(pin)) return true;
  if (COMMON_WEAK_PINS.has(pin)) return true;
  if (isAllSameDigits(pin)) return true;
  if (isSequential(pin)) return true;
  return false;
};
