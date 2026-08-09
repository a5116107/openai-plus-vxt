/** Replace an element's markup without assigning dynamic innerHTML. */
export function setElementHtml(target: ParentNode, html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  target.replaceChildren(...Array.from(parsed.body.childNodes));
}
