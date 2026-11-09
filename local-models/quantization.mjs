import { validate } from '../core/registry.mjs';

export const defaultQuantization={mode:'none'};
export const quantizationSchema={type:'object',additionalProperties:false,required:['mode'],properties:{mode:{enum:['none','q4_0','q8_0']}}};
export function nativeQuantization(profile=defaultQuantization){validate(profile,quantizationSchema);return structuredClone(profile);}
