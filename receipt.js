/* =====================================================
   BAXNAANO — A4 appointment receipt (PDF download + print)
   BXReceipt.pdf(data, settings)   → downloads Baxnaano-BX-XXXXXX.pdf
   BXReceipt.print(data, settings) → browser print dialog ("Save as PDF")
   data: { ref, patient, phone, age, gender, district, returning, notes,
           doctor, specialty, date, time, queue, fee, status, paid_at, created_at }
   ===================================================== */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WEEK = ['Axad', 'Isniin', 'Talaado', 'Arbaco', 'Khamiis', 'Jimce', 'Sabti'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const t12 = (t) => { const [h, m] = String(t || '').slice(0, 5).split(':').map(Number); return isNaN(h) ? '' : `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const dLong = (d) => { if (!d) return ''; const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); return `${WEEK[x.getUTCDay()]}, ${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
  const dt = (iso) => { if (!iso) return ''; const x = new Date(new Date(iso).getTime() + 3 * 3600e3); return `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}, ${t12(x.toISOString().slice(11, 16))}`; };
  const money = (n) => '$' + (Number(n) % 1 ? Number(n).toFixed(2) : Number(n || 0).toFixed(2));
  const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return /^0\d{9}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : /^252\d{9}$/.test(d) ? `+252 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : (p || '—'); };
  const short = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').trim() || s;

  function loadScript(src, test) {
    return new Promise((res, rej) => {
      if (test()) return res();
      const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Internet ma jiro — fadlan isku day mar kale.'));
      document.head.appendChild(s);
    });
  }
  async function qrSVG(text) {
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js', () => window.qrcode);
      const q = window.qrcode(0, 'M'); q.addData(text); q.make();
      const n = q.getModuleCount(), cell = 12, pad = 2, size = (n + pad * 2) * cell;
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#0f2a3d';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + pad) * cell, (r + pad) * cell, cell, cell);
      return `<img class="rx-qrimg" src="${cv.toDataURL('image/png')}" alt="QR">`;
    } catch (e) { return ''; }
  }

  const CSS = `
  .rx{width:794px;height:1122px;box-sizing:border-box;background:#fff;color:#0f2a3d;font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;position:relative;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact;line-height:1.45}
  .rx *{box-sizing:border-box}
  .rx-top{position:relative;height:168px;padding:34px 46px 0;color:#fff;background:linear-gradient(120deg,#0f2a3d 0%,#123a52 55%,#0a6c8c 100%);overflow:hidden}
  .rx-top::after{content:"";position:absolute;right:-60px;top:-80px;width:340px;height:340px;border-radius:50%;background:radial-gradient(circle,rgba(11,143,122,.55),transparent 65%)}
  .rx-brand{display:flex;align-items:center;gap:16px;position:relative;z-index:1}
  .rx-logo{width:66px;height:66px;border-radius:18px;background:#fff;padding:7px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
  .rx-logo img{width:100%;height:100%;object-fit:contain;display:block}
  .rx-hn{font-size:27px;font-weight:800;letter-spacing:-.02em}
  .rx-tg{font-size:13px;color:#9fe3d4;font-weight:600;margin-top:1px}
  .rx-doc{position:absolute;right:46px;top:26px;text-align:right;z-index:1}
  .rx-doc b{display:block;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#9fe3d4}
  .rx-doc span{display:block;font-size:20px;font-weight:800;margin-top:2px}
  .rx-doc small{display:block;font-size:11.5px;color:#c3d8e2;margin-top:2px}
  .rx-contact{position:absolute;left:46px;right:46px;bottom:16px;display:flex;gap:22px;font-size:11.5px;color:#c3d8e2;z-index:1}
  .rx-band{height:6px;background:linear-gradient(90deg,#0b8f7a,#5eead4,#0a6c8c)}
  .rx-body{padding:30px 46px 0}
  .rx-hero{display:grid;grid-template-columns:200px 1fr;gap:18px;align-items:stretch}
  .rx-q{border-radius:20px;background:linear-gradient(160deg,#e6f5f1,#d9eef6);border:1.5px solid #bfe3da;text-align:center;padding:18px 10px}
  .rx-q small{display:block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#08624f;font-weight:800}
  .rx-q b{display:block;font-size:84px;line-height:1;font-weight:800;color:#0f2a3d;margin:8px 0 4px;letter-spacing:-.04em}
  .rx-q em{font-style:normal;font-size:11.5px;color:#3d5a6c}
  .rx-when{border-radius:20px;border:1.5px solid #e2eaee;padding:18px 22px;display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;position:relative}
  .rx-k{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#6b8494;font-weight:700}
  .rx-v{font-size:17px;font-weight:800;margin-top:2px}
  .rx-v.sm{font-size:14.5px}
  .rx-stamp{position:absolute;right:46px;top:112px;z-index:3;transform:rotate(-8deg);border:3.5px solid currentColor;border-radius:14px;padding:6px 14px;text-align:center;font-weight:800;background:#fff;box-shadow:0 4px 14px rgba(15,42,61,.08)}
  .rx-stamp b{display:block;font-size:22px;letter-spacing:.06em;line-height:1.1}
  .rx-stamp small{display:block;font-size:10px;letter-spacing:.14em}
  .rx-stamp.paid{color:#0e8a55}.rx-stamp.pending{color:#c27c0e}.rx-stamp.cancelled{color:#c2414b}.rx-stamp.arrived{color:#1d4ed8}
  .rx-sec{margin-top:24px}
  .rx-h{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#0b8f7a;margin-bottom:10px}
  .rx-h::after{content:"";flex:1;height:1.5px;background:#e2eaee}
  .rx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1.5px solid #e2eaee;border-radius:16px;overflow:hidden}
  .rx-cell{padding:12px 16px;border-right:1.5px solid #e2eaee;border-bottom:1.5px solid #e2eaee}
  .rx-cell:nth-child(3n){border-right:0}
  .rx-cell.last{border-bottom:0}
  .rx-cell .rx-v{font-size:14.5px}
  .rx-two{display:grid;grid-template-columns:1fr 230px;gap:18px;margin-top:24px}
  .rx-pay{border:1.5px solid #e2eaee;border-radius:16px;overflow:hidden}
  .rx-pay table{width:100%;border-collapse:collapse;font-size:13.5px}
  .rx-pay td{padding:11px 16px;border-bottom:1.5px solid #eef3f5}
  .rx-pay td:last-child{text-align:right;font-weight:700;white-space:nowrap}
  .rx-pay tr.tot td:first-child{white-space:nowrap}
  .rx-pay tr.tot td{background:#0f2a3d;color:#fff;font-size:17px;font-weight:800;border:0}
  .rx-pay tr.tot td:last-child{color:#5eead4}
  .rx-qr{border:1.5px solid #e2eaee;border-radius:16px;padding:14px;text-align:center}
  .rx-qr .rx-qrimg{width:150px;height:150px;display:block;margin:0 auto 6px;image-rendering:pixelated}
  .rx-qr b{display:block;font-size:12.5px}
  .rx-qr small{display:block;font-size:10.5px;color:#6b8494;word-break:break-all}
  .rx-notes{margin-top:22px;border-radius:16px;background:#f3f8fa;padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:6px 26px;font-size:12px;color:#3d5a6c}
  .rx-notes div::before{content:"✓";color:#0b8f7a;font-weight:800;margin-right:8px}
  .rx-foot{position:absolute;left:0;right:0;bottom:0;padding:16px 46px;border-top:1.5px dashed #d5e1e6;display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#6b8494}
  .rx-foot b{color:#0f2a3d}
  .rx-wm{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%) rotate(-24deg);font-size:120px;font-weight:800;color:rgba(11,143,122,.045);white-space:nowrap;pointer-events:none;letter-spacing:.05em}
  `;

  async function build(d, S) {
    S = S || {};
    const st = d.status || 'pending';
    const stamp = { paid: ['LA BIXIYAY', 'PAID'], arrived: ['WUU YIMID', 'CHECKED IN'], pending: ['LACAG SUGAYA', 'PAYMENT PENDING'], cancelled: ['LA JOOJIYAY', 'CANCELLED'] }[st] || [st, ''];
    const site = location.origin + location.pathname.replace(/[^/]*$/, '');
    const checkUrl = `${site}?ref=${encodeURIComponent(d.ref)}`;
    const qr = await qrSVG(checkUrl);
    const phones = (S.phones && S.phones.length ? S.phones : (S.whatsapp ? ['+' + String(S.whatsapp).replace(/\D/g, '')] : [])).map(fmtPhone);
    const paidRow = (st === 'paid' || st === 'arrived');
    const gender = d.gender === 'male' ? 'Lab (Male)' : d.gender === 'female' ? 'Dhedig (Female)' : '—';
    const cells = [
      ['Bukaanka · Patient', d.patient], ['Taleefanka · Phone', fmtPhone(d.phone)], ["Da'da · Age", d.age != null && d.age !== '' ? d.age + ' sano' : '—'],
      ['Jinsiga · Gender', gender], ['Degmada · District', d.district || '—'], ['Booqasho · Visit', d.returning ? 'Dib-u-eeg (Follow-up)' : 'Cusub (New)']
    ];
    const el = document.createElement('div');
    el.className = 'rx';
    el.innerHTML = `<style>${CSS}</style>
      <div class="rx-wm">BAXNAANO</div>
      <div class="rx-stamp ${esc(st)}"><b>${stamp[0]}</b><small>${stamp[1]}</small></div>
      <div class="rx-top">
        <div class="rx-brand"><div class="rx-logo"><img src="icon-192.png" alt=""></div><div><div class="rx-hn">${esc(S.hospital_name || 'Baxnaano Hospital')}</div><div class="rx-tg">${esc(S.tagline || 'Treatment and beyond')}</div></div></div>
        <div class="rx-doc"><b>Rasiidka Ballanka</b><span>${esc(d.ref)}</span><small>Appointment Receipt</small></div>
        <div class="rx-contact"><span>📍 ${esc(S.address || 'Muqdisho, Soomaaliya')}</span>${phones.length ? `<span>📞 ${esc(phones.join('  ·  '))}</span>` : ''}${S.email ? `<span>✉️ ${esc(S.email)}</span>` : ''}</div>
      </div>
      <div class="rx-band"></div>
      <div class="rx-body">
        <div class="rx-hero">
          <div class="rx-q"><small>Lambarka Safka</small><b>#${esc(d.queue)}</b><em>Queue number</em></div>
          <div class="rx-when">
            <div><div class="rx-k">Taariikhda · Date</div><div class="rx-v">${esc(dLong(d.date))}</div></div>
            <div><div class="rx-k">Dhakhtarku joogaa · Doctor hours</div><div class="rx-v">${d.start ? esc(t12(d.start) + " – " + t12(d.end)) : "—"}</div></div>
            <div><div class="rx-k">Dhakhtarka · Doctor</div><div class="rx-v sm">${esc(d.doctor)}</div></div>
            <div><div class="rx-k">Takhasuska · Specialty</div><div class="rx-v sm">${esc(d.specialty)}</div></div>
          </div>
        </div>

        <div class="rx-sec"><div class="rx-h">Xogta bukaanka · Patient details</div>
          <div class="rx-grid">${cells.map(([k, v], i) => `<div class="rx-cell${i >= 3 ? ' last' : ''}"><div class="rx-k">${k}</div><div class="rx-v">${esc(v)}</div></div>`).join('')}</div>
        </div>

        <div class="rx-two">
          <div><div class="rx-h">Lacag-bixinta · Payment</div>
            <div class="rx-pay"><table>
              <tr><td>Ballanka dhakhtarka — ${esc(short(d.specialty))}</td><td>${money(d.fee)}</td></tr>
              <tr><td>Habka bixinta · Method</td><td>USSD ${esc(S.ussd_prefix || '*712*')}</td></tr>
              <tr><td>Xaaladda · Status</td><td style="color:${paidRow ? '#0e8a55' : st === 'cancelled' ? '#c2414b' : '#c27c0e'}">${paidRow ? '✓ La bixiyay · Paid' : st === 'cancelled' ? 'La joojiyay · Cancelled' : 'Sugaya · Pending'}</td></tr>
              ${d.paid_at ? `<tr><td>La bixiyay · Paid on</td><td>${esc(dt(d.paid_at))}</td></tr>` : ''}
              ${d.created_at ? `<tr><td>La ballansaday · Booked on</td><td>${esc(dt(d.created_at))}</td></tr>` : ''}
              <tr class="tot"><td>${paidRow ? 'Wadarta la bixiyay · Total paid' : 'Wadarta · Total due'}</td><td>${money(d.fee)}</td></tr>
            </table></div>
          </div>
          <div><div class="rx-h">Hubi · Verify</div>
            <div class="rx-qr">${qr || `<div style="height:150px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px">${esc(d.ref)}</div>`}<b>Scan si aad u hubiso</b><small>Scan to check this booking</small></div>
          </div>
        </div>

        <div class="rx-notes">
          <div>Lambar hore = hore ayaad u gelaysaa</div><div>You are seen in queue-number order</div>
          <div>Soo qaado rasiidkan (taleefan ama warqad)</div><div>Bring this receipt (phone or printed)</div>
          <div>Soo qaado warqadihii iyo daawooyinkii hore</div><div>Bring previous reports and medicines</div>
        </div>
      </div>
      <div class="rx-foot"><span><b>${esc(S.hospital_name || 'Baxnaano Hospital')}</b> · Mahadsanid · Thank you</span><span>Generated ${esc(dt(new Date().toISOString()))}</span></div>`;
    await Promise.all([...el.querySelectorAll('img')].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
    return el;
  }

  async function pdf(d, S) {
    const el = await build(d, S);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:794px;height:1122px;z-index:-1;opacity:0;pointer-events:none';
    holder.appendChild(el); document.body.appendChild(holder);
    try {
      await new Promise((r) => setTimeout(r, 80));
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js', () => window.html2pdf);
      holder.style.opacity = '1';
      await window.html2pdf().set({
        margin: 0, filename: `Baxnaano-${d.ref}.pdf`, image: { type: 'jpeg', quality: 0.96 },
        html2canvas: { scale: 2.5, useCORS: true, backgroundColor: '#ffffff', width: 794, height: 1122, windowWidth: 794, scrollX: 0, scrollY: 0 },
        jsPDF: { unit: 'px', format: [794, 1122], orientation: 'portrait', hotfixes: ['px_scaling'] }
      }).from(el).save();
    } catch (e) {
      holder.remove();
      return print(d, S); // fall back to the print dialog ("Save as PDF")
    }
    holder.remove();
  }

  async function print(d, S) {
    const el = await build(d, S);
    let host = document.getElementById('rxPrintHost');
    if (!host) {
      host = document.createElement('div'); host.id = 'rxPrintHost'; document.body.appendChild(host);
      const st = document.createElement('style');
      st.textContent = `#rxPrintHost{display:none}
        @media print{@page{size:A4;margin:0} html,body{margin:0!important;padding:0!important;background:#fff!important;height:auto!important;overflow:visible!important}
        body>*:not(#rxPrintHost){display:none!important} #rxPrintHost{display:block!important}
        #rxPrintHost .rx{width:210mm;height:296.5mm;zoom:${(210 / 25.4 * 96 / 794).toFixed(4)};page-break-after:avoid;break-after:avoid}}`;
      document.head.appendChild(st);
    }
    host.innerHTML = ''; host.appendChild(el);
    setTimeout(() => window.print(), 150);
  }

  window.BXReceipt = { build, pdf, print };
})();
