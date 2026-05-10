// netlify/functions/proxy.js
// 轉發新北市政府開放資料平台的實價登錄 API，繞過瀏覽器 CORS 限制
// Dataset: 不動產實價登錄資訊-買賣案件

const DATASET_ID = 'ACCE802D-58CC-4DFF-9E7A-9ECC517F78BE';
const BASE_URL = `https://data.ntpc.gov.tw/api/datasets/${DATASET_ID}/json`;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const community = (params.community || '').trim();
    const dateFrom  = params.dateFrom || '';
    const dateTo    = params.dateTo   || '';
    const page      = parseInt(params.page || '1', 10);
    const size      = Math.min(parseInt(params.size || '1000', 10), 1000);

    if (!community) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '請提供 community 參數' }) };
    }

    const apiUrl = `${BASE_URL}?page=${page}&size=${size}`;

    const resp = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'RealEstateTool/1.0' },
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: `API 錯誤 ${resp.status}`, detail: errText.slice(0,200) }) };
    }

    const raw = await resp.json();
    const allRows = Array.isArray(raw) ? raw : (raw.result?.records || raw.records || []);

    // 民國日期轉換
    function rocToYearMonth(str) {
      if (!str || str.length < 5) return null;
      const clean = str.replace(/[\/\-]/g, '');
      const roc = parseInt(clean.slice(0, 3), 10);
      const m   = clean.slice(3, 5);
      if (isNaN(roc) || roc < 80 || roc > 200) return null;
      return `${roc + 1911}-${m}`;
    }

    function toRocDate(yearMonth, type) {
      const [y, m] = yearMonth.split('-').map(Number);
      const roc = String(y - 1911).padStart(3, '0');
      const mStr = String(m).padStart(2, '0');
      if (type === 'start') return `${roc}${mStr}01`;
      const lastDay = new Date(y, m, 0).getDate();
      return `${roc}${mStr}${String(lastDay).padStart(2, '0')}`;
    }

    const rocFrom = dateFrom ? toRocDate(dateFrom, 'start') : '0800101';
    const rocTo   = dateTo   ? toRocDate(dateTo, 'end')     : '2001231';

    function parseFloorStr(str) {
      if (!str) return 0;
      const n = parseInt(str);
      if (!isNaN(n)) return n;
      const map = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,
        '十':10,'十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,
        '十七':17,'十八':18,'十九':19,'二十':20};
      return map[str.replace(/[層F樓]/g,'').trim()] || 0;
    }

    const records = allRows
      .filter(r => {
        const addr = r['土地區段位置或建物區段門牌'] || r['建物區段門牌或土地區段位置'] || r['rps02'] || '';
        if (!addr.includes(community)) return false;
        const dateField = (r['交易年月日'] || r['rps07_yyymmddroc'] || '').replace(/[\/\-]/g,'');
        if (dateField < rocFrom || dateField > rocTo) return false;
        return true;
      })
      .map(r => {
        const dateField = r['交易年月日'] || r['rps07_yyymmddroc'] || '';
        const date = rocToYearMonth(dateField.replace(/[\/\-]/g,''));
        if (!date) return null;

        const areaRaw = parseFloat(r['建物移轉總面積平方公尺'] || r['rps15_area'] || 0);
        const area = areaRaw / 3.305785;
        if (area < 5 || area > 500) return null;

        const totalRaw = parseFloat(r['總價元'] || r['rps21_amountsunitdollars'] || 0);
        const totalPrice = totalRaw / 10000;
        if (totalPrice < 50) return null;

        const unitRaw = parseFloat(r['單價元平方公尺'] || r['rps22_amountsunitdollars'] || 0);
        const parkingRaw = parseFloat(r['車位總價元'] || r['rps25_amountsunitdollars'] || 0);
        const parking = parkingRaw / 10000;
        const adjTotal = totalPrice - parking;

        let unitPrice = unitRaw > 0 ? (unitRaw * 3.305785) / 10000 : (area > 0 ? adjTotal / area : 0);
        if (unitPrice < 3 || unitPrice > 500) return null;

        return {
          date,
          address:    r['土地區段位置或建物區段門牌'] || r['建物區段門牌或土地區段位置'] || '',
          area:       Math.round(area * 10) / 10,
          totalPrice: Math.round(adjTotal * 10) / 10,
          unitPrice:  Math.round(unitPrice * 10) / 10,
          floor:      parseFloorStr(r['移轉層次'] || r['rps09'] || ''),
          totalFloor: parseInt(r['建物現況格局-總層數'] || r['rps10'] || 0) || 0,
          type:       r['建物型態'] || r['rps11'] || '',
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ total: allRows.length, page, size, records }),
    };

  } catch (err) {
    console.error('Proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
