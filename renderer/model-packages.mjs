import { formatBytes, formatVram } from './model-helpers.mjs';

export function createPackageChoices({ model, el, onSelect }) {
  const root = el('section', 'model-packages'); root.id = 'model-packages';
  let selected;
  const controls = [];
  if (model.packages?.length) root.append(el('h3', '', 'Complete model packages'), el('p', 'hint', 'Includes the selected weights and their published configuration and support files. Downloading does not install a runtime.'));
  for (const item of model.packages || []) {
    const section = el('div', 'model-package'); section.dataset.packageId = item.id;
    section.append(el('h4', '', item.label));
    if (item.type === 'minimax-music3') {
      section.append(el('p', 'hint', item.memoryNote));
      const choices = {}, selects = [];
      for (const component of item.components) {
        const label = el('label', 'field'); label.append(el('span', '', component.label));
        const select = el('select'); select.dataset.component = component.role; select.setAttribute('aria-label', `${component.label} quantization`);
        const placeholder = el('option', '', component.variants.length ? 'Choose a quantization…' : 'Missing component'); placeholder.value = ''; select.append(placeholder);
        for (const variant of component.variants) {
          const option = el('option', '', `${variant.encoding} · ${formatBytes(variant.sizeBytes)}${variant.complete ? '' : ` · ${variant.reason}`}`); option.value = variant.id; option.disabled = !variant.complete; select.append(option);
        }
        select.addEventListener('change', () => {
          const value = select.value;
          if (selected?.id !== item.id) clear();
          select.value = value; choices[component.role] = value;
          selected = { ...item, choices: { ...choices }, complete: item.complete && item.components.every(value => choices[value.role]) };
          const files = [...item.files, ...item.components.flatMap(value => value.variants.find(variant => variant.id === choices[value.role])?.files || [])];
          onSelect(files);
        });
        label.append(select); section.append(label); selects.push(select);
      }
      controls.push(() => { selects.forEach(select => { select.value = ''; }); Object.keys(choices).forEach(key => delete choices[key]); });
    } else {
      const choose = el('button', 'button', `Select package · ${formatBytes(item.sizeBytes)}`); choose.type = 'button'; choose.disabled = !item.complete; choose.dataset.packageChoice = item.id; choose.setAttribute('aria-pressed', 'false');
      choose.addEventListener('click', () => { clear(); selected = item; choose.setAttribute('aria-pressed', 'true'); onSelect(item.files); });
      section.append(choose, el('p', 'hint', `${item.files.length} files · VRAM estimate ${formatVram(item.vram)}. ${item.runtime}`));
      controls.push(() => choose.setAttribute('aria-pressed', 'false'));
    }
    if (item.reason) section.append(el('p', 'hint error-text', item.reason));
    root.append(section);
  }
  function clear() { selected = undefined; controls.forEach(reset => reset()); }
  return { root, clear, selected: () => selected };
}
