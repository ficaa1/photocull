// Formatting shared by photo labels, scope summaries and destination previews.
window.PhotoCullPresentation = (() => {
  const count = new Intl.NumberFormat().format;
  const segments = Intl.Segmenter && new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  function quantity(n, singular, plural = singular + 's') {
    return count(n) + ' ' + (n === 1 ? singular : plural);
  }
  function filename(label, name, status = '') {
    const title = name + status;
    if (label.classList.contains('filename') && label.title === title) return;
    label.classList.add('filename');
    label.title = title;
    const parts = segments ? Array.from(segments.segment(name), part => part.segment) : Array.from(name);
    const head = document.createElement('span'), tail = document.createElement('span');
    head.textContent = parts.slice(0, -12).join('');
    tail.textContent = parts.slice(-12).join('') + status;
    label.replaceChildren(head, tail);
  }
  return { count, quantity, filename };
})();
