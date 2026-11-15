// Small DOM helpers shared by the whole app.
export const $ = (id) => document.getElementById(id);

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter(Boolean));
  return node;
};

/**
 * Asks for a line of text in the app's own dialog, with `value` already in the box (Android's prompt() inside the
 * app shows an empty box: Capacitor ignores the default value). Resolves to the text, or null when cancelled.
 */
export function askText(message, value = '', { multiline = false, maxLength = 200 } = {}) {
  return new Promise((resolve) => {
    const field = el(multiline ? 'textarea' : 'input', { className: 'ask-field', value, maxLength, rows: 3 });
    const ok = el('button', { type: 'submit', value: 'ok', textContent: 'אישור', className: 'primary' });
    const cancel = el('button', { type: 'button', textContent: 'ביטול' });
    const form = el('form', { method: 'dialog' }, el('label', { className: 'ask-label', textContent: message }), field,
      el('div', { className: 'dialog-actions' }, cancel, ok));
    const dlg = el('dialog', { className: 'settings ask-dialog' }, form);
    let answer = null;
    form.addEventListener('submit', () => { answer = field.value; });
    cancel.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });
    document.body.append(dlg);
    dlg.showModal();
    field.focus();
    field.select();
  });
}
