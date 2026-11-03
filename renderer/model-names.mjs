export function modelDisplayName(providerId, model, labels = [], fallback = 'Choose a model') {
  const match = labels.find(item => item.providerId === providerId && item.model === model && typeof item.displayName === 'string' && item.displayName.trim());
  return match?.displayName || model || fallback;
}
