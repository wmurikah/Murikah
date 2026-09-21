export function committeePdf(lines: string[]): Blob {
  const escape = (value: string) => value.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const objects: string[] = [];
  const pages: number[] = [];
  const pageSize = 42;
  const pageChunks: string[][] = [];
  for(let i=0;i<lines.length;i+=pageSize) pageChunks.push(lines.slice(i,i+pageSize));
  if(pageChunks.length===0) pageChunks.push(['Assurance OS committee pack']);

  let objNo=4;
  for(const pageLines of pageChunks){
    const commands: string[]=['BT','/F1 10 Tf','50 790 Td','14 TL'];
    pageLines.forEach((line,index)=>commands.push((index===0?'':'T* ') + '(' + escape(line) + ') Tj'));
    commands.push('ET');
    const stream=commands.join('\n');
    const contentNo=objNo++;
    const pageNo=objNo++;
    objects[contentNo]='<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
    objects[pageNo]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + contentNo + ' 0 R >>';
    pages.push(pageNo);
  }
  objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  objects[2]='<< /Type /Pages /Kids [' + pages.map(n=>String(n)+' 0 R').join(' ') + '] /Count ' + pages.length + ' >>';
  objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let body='%PDF-1.4\n';
  const offsets:number[]=[0];
  for(let i=1;i<objects.length;i++){
    if(!objects[i]) continue;
    offsets[i]=body.length;
    body += String(i) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xref=body.length;
  body += 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
  for(let i=1;i<objects.length;i++) body += String(offsets[i] ?? 0).padStart(10,'0') + ' 00000 n \n';
  body += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return new Blob([body],{type:'application/pdf'});
}
