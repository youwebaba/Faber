import { validate } from '../core/registry.mjs';

export const defaultQuantization={mode:'none'};
export const quantizationSchema={type:'object',additionalProperties:false,required:['mode'],properties:{mode:{enum:['none','q4_0','q8_0']}}};
export function nativeQuantization(profile=defaultQuantization){validate(profile,quantizationSchema);return structuredClone(profile);}
export function savedNativeQuantization(profile){try{return {quantization:nativeQuantization(profile)};}catch{return {quantization:null,quantizationWarning:'The saved native precision profile is unsupported in this version. Choose a supported load profile before Start.'};}}
export function resolveNativeQuantization(explicit,saved){if(explicit!==undefined)return nativeQuantization(explicit);const result=savedNativeQuantization(saved);if(!result.quantization)throw new Error(result.quantizationWarning);return result.quantization;}
