import type { TemplateLayoutJson, Layer } from '../../types/template-layout';

interface GenerateOptions {
  watermark?: {
    text: string;
    opacity: number;
    angle: number;
    fontSize?: number;
  };
  assetBaseUrl?: string;
}

const px = (value: number) => `${value}px`;

/**
 * Buduje pełny HTML (inline CSS) na podstawie layoutJson z wizualnego edytora.
 * Render jest prosty, ale odzwierciedla pozycjonowanie absolutne warstw.
 */
export function generateHTMLFromLayout(
  layout: TemplateLayoutJson,
  answers: Record<string, any>,
  options: GenerateOptions = {}
): string {
  const assetBaseUrl = (options.assetBaseUrl || '').replace(/\/+$/, '') + '/';

  const fontsCss = layout.fonts
    .map(
      (font) => `
@font-face {
  font-family: '${font.family}';
  src: url('${font.src}');
  font-weight: ${font.weight};
  font-style: ${font.style};
}
`
    )
    .join('\n');

  const containerStyle = `
    position: relative;
    width: ${px(layout.canvas.width)};
    height: ${px(layout.canvas.height)};
    background: ${layout.canvas.backgroundColor || '#fff'};
    overflow: hidden;
  `;

  const layersHtml = layout.layers
    .filter((l) => l.visible !== false)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((layer) => renderLayer(layer, answers, assetBaseUrl))
    .join('\n');

  const watermarkHtml = options.watermark
    ? `<div style="
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        color:rgba(0,0,0,${options.watermark.opacity});
        font-size:${options.watermark.fontSize || 96}px;
        font-weight:700;
        transform:rotate(${options.watermark.angle}deg);
        pointer-events:none;
        user-select:none;
      ">${options.watermark.text}</div>`
    : '';

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; padding: 0; margin: 0; }
      ${fontsCss}
    </style>
  </head>
  <body style="margin:0; padding:0; display:flex; align-items:center; justify-content:center; background:#f8f8f8;">
    <div id="canvas" style="${containerStyle}">
      ${layersHtml}
      ${watermarkHtml}
    </div>
  </body>
</html>`;
}

function renderLayer(layer: Layer, answers: Record<string, any>, assetBaseUrl: string): string {
  const common = `
    position:absolute;
    left:${px(layer.x)};
    top:${px(layer.y)};
    width:${px(layer.width)};
    height:${px(layer.height)};
    opacity:${layer.opacity ?? 1};
    transform:rotate(${layer.rotation || 0}deg);
    ${layer.locked ? 'pointer-events:none;' : ''}
  `;

  if (layer.type === 'background' || layer.type === 'image') {
    const imgUrl = layer.properties.imageUrl.startsWith('http')
      ? layer.properties.imageUrl
      : `${assetBaseUrl}${layer.properties.imageUrl}`;
    return `<img src="${imgUrl}" alt="${layer.name}" style="${common} object-fit:${layer.properties.fit};" />`;
  }

  if (layer.type === 'text') {
    const props = layer.properties;
    const value = answers[props.fieldKey] ?? props.placeholder ?? '';
    return `<div style="${common}
      font-family:'${props.fontFamily}', sans-serif;
      font-size:${px(props.fontSize)};
      font-weight:${props.fontWeight};
      font-style:${props.fontStyle};
      color:${props.fill};
      text-align:${props.textAlign};
      line-height:${props.lineHeight};
      display:flex;
      align-items:center;
      justify-content:${props.textAlign === 'center' ? 'center' : props.textAlign === 'right' ? 'flex-end' : 'flex-start'};
      padding:4px;
      overflow:hidden;
      word-break:break-word;
      text-transform:${props.textTransform};
    ">${escapeHtml(String(value || ''))}</div>`;
  }

  if (layer.type === 'static_text') {
    const props = layer.properties;
    return `<div style="${common}
      font-family:'${props.fontFamily}', sans-serif;
      font-size:${px(props.fontSize)};
      font-weight:${props.fontWeight};
      font-style:${props.fontStyle};
      color:${props.fill};
      text-align:${props.textAlign};
      line-height:${props.lineHeight};
      display:flex;
      align-items:center;
      justify-content:${props.textAlign === 'center' ? 'center' : props.textAlign === 'right' ? 'flex-end' : 'flex-start'};
      padding:4px;
      overflow:hidden;
      word-break:break-word;
    ">${escapeHtml(String(props.text || ''))}</div>`;
  }

  if (layer.type === 'shape') {
    const props = layer.properties;
    const borderRadius =
      props.shapeType === 'circle'
        ? '50%'
        : props.shapeType === 'ellipse'
          ? '50% / 50%'
          : `${props.borderRadius || 0}px`;
    return `<div style="${common}
      background:${props.fill};
      border:${props.strokeWidth}px solid ${props.stroke};
      border-radius:${borderRadius};
    "></div>`;
  }

  // cut_line or unknown -> render dashed outline (optionally hidden for client)
  if (layer.type === 'cut_line') {
    const props = layer.properties;
    return `<div style="${common}
      border:${props.strokeWidth}px dashed ${props.stroke};
      opacity:${props.clientVisible ? props.strokeWidth : 0};
      pointer-events:none;
    "></div>`;
  }

  return '';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


