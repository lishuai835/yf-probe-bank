/* YF专用检测工具 · 多人免登录云端指纹库实时融合 Worker (Cloudflare Workers / Node 22+)
   接收二次验证确认「✅ 正确」的指纹样本 -> 严格防投毒门控校验 -> 直接拉取开源仓库最新指纹库 ->
   实时融合 Hellinger(355d) + OrderedBlocks(74d) 质心与 Ikale 共享检测器近邻参考集 ->
   通过 Git Data API 原子提交回 lishuai835/yf-probe-bank (仅需普通 repo 权限 Token，零客户端密钥暴露)。 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-YF-Client',
  'Access-Control-Max-Age': '86400',
};

const VALUE_MIN = 1;
const VALUE_MAX = 355;
const DIMENSION = 355;
const ALPHA = 0.5;
const MAX_REFERENCES_PER_MODEL = 96;
const TARGET_OVERWRITE_ALPHA = 0.72;
const WRONG_REPEL_MARGIN = 0.42;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 15;
const ipBuckets = new Map();

const DISPLAY_ALIAS_TO_ID = Object.freeze({
  'hunyuan 4 preview': 'hy4-preview',
  'hunyuan-4-preview': 'hy4-preview',
});

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipBuckets.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    ipBuckets.set(ip, {start: now, count: 1});
    if (ipBuckets.size > 2000) {
      for (const [k, v] of ipBuckets) if (now - v.start > RATE_WINDOW_MS) ipBuckets.delete(k);
    }
    return true;
  }
  if (entry.count >= RATE_MAX_PER_IP) return false;
  entry.count += 1;
  return true;
}

function parseNumbers(text) {
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of String(text || '').matchAll(/\d+/g)) {
    const separator = String(text || '').slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => (run.length > best.length ? run : best), []);
}

function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  for (const n of numbers) counts[n - VALUE_MIN] += 1;
  return counts;
}

function evaluateSampleGate(values, expected = 297) {
  const length = values.length;
  const steps = Math.max(0, length - 1);
  let nonDec = 0, nonInc = 0;
  const stepSizes = new Map();
  for (let i = 1; i < length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) nonDec += 1;
    if (d <= 0) nonInc += 1;
    const abs = Math.abs(d);
    stepSizes.set(abs, (stepSizes.get(abs) || 0) + 1);
  }
  const modalStep = steps ? Math.max(...stepSizes.values()) : 0;
  const uniqueCount = new Set(values).size;
  const uniqueRatio = length ? uniqueCount / Math.min(length, DIMENSION) : 0;
  const minLength = Math.max(80, Math.ceil((Number(expected) || 297) * 0.55));
  if (length < minLength || length > 600) return {ok: false, rule: 'length_invalid'};
  if (uniqueCount <= 1 || uniqueRatio < 0.05) return {ok: false, rule: 'low_unique'};
  if (steps >= 2 && Math.max(nonDec, nonInc) / steps >= 0.9) return {ok: false, rule: 'monotonic'};
  if (steps >= 2 && modalStep / steps >= 0.5) return {ok: false, rule: 'arithmetic'};
  return {ok: true, rule: null};
}

function dot(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i];
  return sum;
}

function normalized(values) {
  const scale = Math.max(Math.sqrt(dot(values, values)), 1e-12);
  return values.map(v => v / scale);
}

function subtractBasis(values, basis) {
  const out = values.slice();
  for (const vec of basis || []) {
    const proj = dot(out, vec);
    for (let i = 0; i < out.length; i += 1) out[i] -= proj * vec[i];
  }
  return out;
}

function hellingerRawFeature(counts) {
  const total = counts.reduce((s, v) => s + v, 0) + ALPHA * DIMENSION;
  return counts.map(v => Math.sqrt((v + ALPHA) / total));
}

function hellingerUnitVector(counts, artifact) {
  const feat = hellingerRawFeature(counts);
  const std = feat.map((v, i) => (v - artifact.feature_mean[i]) / artifact.feature_scale[i]);
  return normalized(subtractBasis(std, artifact.nuisance_basis));
}

function orderedBlockRawFeature(numbers) {
  const base = Math.floor(numbers.length / 4);
  const rem = numbers.length % 4;
  const pieces = [];
  let start = 0;
  for (let c = 0; c < 4; c += 1) {
    const size = base + (c < rem ? 1 : 0);
    const chunk = numbers.slice(start, start + size);
    start += size;
    const bins = Array(16).fill(0.5);
    for (const v of chunk) bins[Math.min(15, Math.floor(((v - 1) / 355) * 16))] += 1;
    const total = bins.reduce((s, v) => s + v, 0);
    pieces.push(...bins.map(v => Math.sqrt(v / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  for (const v of numbers) lastDigits[v % 10] += 1;
  const lastTotal = lastDigits.reduce((s, v) => s + v, 0);
  pieces.push(...lastDigits.map(v => Math.sqrt(v / lastTotal)));
  return pieces;
}

function orderedBlockUnitVector(numbers, artifact) {
  const feat = orderedBlockRawFeature(numbers);
  const std = feat.map((v, i) => (v - artifact.feature_mean[i]) / artifact.feature_scale[i]);
  return normalized(subtractBasis(std, artifact.nuisance_basis));
}

function orderedBlockCenteredRawUnit(numbers, artifact) {
  const feat = orderedBlockRawFeature(numbers);
  const std = feat.map((v, i) => (v - artifact.feature_mean[i]) / artifact.feature_scale[i]);
  return normalized(std);
}

function sharedDetectorRefVector(counts, numbers, fullParams) {
  const blocks = [hellingerRawFeature(counts), orderedBlockRawFeature(numbers)];
  return blocks.flatMap((vec, j) => {
    const std = vec.map((x, i) => (x - fullParams[j].mean[i]) / fullParams[j].scale[i]);
    const weight = Math.sqrt(j === 0 ? 0.75 : 0.25);
    return normalized(std).map(x => Number((x * weight).toFixed(7)));
  });
}

function sumVectors(vectors, dim) {
  const acc = Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i += 1) acc[i] += vec[i];
  }
  return acc;
}

function blendUnit(oldVec, targetVec, alpha) {
  return normalized(oldVec.map((v, i) => (1 - alpha) * v + alpha * targetVec[i]));
}

function repelUnit(wrongVec, sampleVec, margin = WRONG_REPEL_MARGIN) {
  const proj = dot(wrongVec, sampleVec);
  const pull = Math.max(0, proj) + margin;
  return normalized(wrongVec.map((v, i) => v - pull * sampleVec[i]));
}

function sqDist(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const d = left[i] - right[i];
    sum += d * d;
  }
  return sum;
}

const bareModel = id => String(id || '').split('@', 1)[0];

function resolveModelIndex(bank, {modelId, displayName}) {
  const slug = v => String(v || '').trim().toLowerCase().replace(/[._\s-]+/g, '-');
  const rawName = String(displayName || '').trim().toLowerCase();
  const aliased = DISPLAY_ALIAS_TO_ID[rawName] || DISPLAY_ALIAS_TO_ID[slug(rawName)] || '';
  const rawId = String(modelId || aliased || '').trim().toLowerCase();
  const bare = bareModel(rawId);
  const bareSlug = slug(bare);
  let idx = bank.models.findIndex(m => String(m.id).toLowerCase() === rawId);
  if (idx >= 0) return idx;
  if (bare) {
    idx = bank.models.findIndex(m => bareModel(String(m.id).toLowerCase()) === bare);
    if (idx >= 0) return idx;
    idx = bank.models.findIndex(m => slug(bareModel(m.id)) === bareSlug);
    if (idx >= 0) return idx;
  }
  if (rawName) {
    if (DISPLAY_ALIAS_TO_ID[rawName]) {
      idx = bank.models.findIndex(m => String(m.id).toLowerCase() === DISPLAY_ALIAS_TO_ID[rawName]);
      if (idx >= 0) return idx;
    }
    idx = bank.models.findIndex(m => String(m.display_name || '').trim().toLowerCase() === rawName);
    if (idx >= 0) return idx;
    idx = bank.models.findIndex(m => slug(m.display_name) === slug(rawName));
    if (idx >= 0) return idx;
    idx = bank.models.findIndex(m => slug(bareModel(m.id)) === slug(rawName));
    if (idx >= 0) return idx;
  }
  return -1;
}

function validateIncomingPayload(body) {
  if (!body || typeof body !== 'object') throw new Error('请求格式无效');
  const modelId = String(body.modelId || body.model_id || '').trim();
  const displayName = String(body.displayName || body.display_name || '').trim();
  const wrongModelId = String(body.wrongModelId || body.wrong_model_id || '').trim().slice(0, 160);
  const wrongDisplayName = String(body.wrongDisplayName || body.wrong_display_name || '').trim().slice(0, 120);
  const isCorrection = body.mode === 'correct' || body.overwrite === true;
  if ((!modelId && !displayName) || modelId.length > 160) throw new Error('模型标识无效');
  if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 3) {
    throw new Error('指纹样本条数必须在 1–3 条之间');
  }
  const usable = [];
  const seen = new Set();
  for (const item of body.samples) {
    const expected = Number(item?.expected_count) || 297;
    if (!Number.isInteger(expected) || expected < 200 || expected > 500) {
      throw new Error('样本预期长度无效');
    }
    const numbers = Array.isArray(item?.numbers)
      ? item.numbers.map(Number).filter(n => Number.isInteger(n) && n >= VALUE_MIN && n <= VALUE_MAX)
      : parseNumbers(item?.text);
    const gate = evaluateSampleGate(numbers, expected);
    if (!gate.ok) throw new Error(`样本未通过防投毒质量校验 (${gate.rule})`);
    const sig = numbers.join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    usable.push({expected_count: expected, numbers, counts: countNumbers(numbers)});
  }
  if (!usable.length) throw new Error('无有效去重指纹样本');
  return {
    modelId,
    displayName: displayName.slice(0, 120),
    wrongModelId,
    wrongDisplayName,
    isCorrection,
    clientVersion: String(body.clientVersion || '0.2.0').slice(0, 32),
    usable,
  };
}

function evolvePair(bank, detector, cleaned) {
  const modelIdx = resolveModelIndex(bank, cleaned);
  if (modelIdx < 0) throw new Error(`开源指纹库未收录该模型: ${cleaned.displayName || cleaned.modelId}`);
  const targetModel = bank.models[modelIdx];
  const cIdx = bank.robust.model_order.indexOf(targetModel.id);
  if (cIdx < 0) throw new Error('质心索引异常');

  const isCorrection = !!cleaned.isCorrection;
  const rawWrongIdx = isCorrection && (cleaned.wrongModelId || cleaned.wrongDisplayName)
    ? resolveModelIndex(bank, {modelId: cleaned.wrongModelId, displayName: cleaned.wrongDisplayName})
    : -1;
  const wrongIdx = rawWrongIdx >= 0 && rawWrongIdx !== modelIdx ? rawWrongIdx : -1;
  const wrongModel = wrongIdx >= 0 ? bank.models[wrongIdx] : null;
  const wrongCIdx = wrongModel ? bank.robust.model_order.indexOf(wrongModel.id) : -1;

  const prevVerified = Math.max(0, Number(targetModel.verified_samples) || 0);
  const wOld = Math.max(1, Number(targetModel.response_count) || 30) + prevVerified;

  const hArt = bank.robust.hellinger;
  const oArt = bank.robust.ordered_blocks;
  const sampleHVecs = [];
  const sampleOVecs = [];
  const sampleORawVecs = [];
  const sampleCountsTotal = Array(355).fill(0);
  let addedNumbers = 0;

  for (const s of cleaned.usable) {
    sampleHVecs.push(hellingerUnitVector(s.counts, hArt));
    sampleOVecs.push(orderedBlockUnitVector(s.numbers, oArt));
    sampleORawVecs.push(orderedBlockCenteredRawUnit(s.numbers, oArt));
    for (let i = 0; i < 355; i += 1) sampleCountsTotal[i] += s.counts[i];
    addedNumbers += s.numbers.length;
  }

  const meanSampleH = normalized(sumVectors(sampleHVecs, 355));
  const meanSampleO = normalized(sumVectors(sampleOVecs, 74));
  const meanSampleORaw = normalized(sumVectors(sampleORawVecs, 74));

  let nextH;
  let nextO;
  let nextCounts;
  if (isCorrection) {
    nextH = blendUnit(hArt.centroids[cIdx], meanSampleH, TARGET_OVERWRITE_ALPHA);
    nextO = blendUnit(oArt.centroids[cIdx], meanSampleO, TARGET_OVERWRITE_ALPHA);
    const oldTotal = Math.max(355, targetModel.counts.reduce((sum, v) => sum + v, 0));
    const scale = oldTotal / Math.max(1, addedNumbers);
    nextCounts = targetModel.counts.map((c, i) => Math.max(0, Math.round(0.35 * c + 0.65 * sampleCountsTotal[i] * scale)));
  } else {
    const hAccum = hArt.centroids[cIdx].map(v => v * wOld);
    const oAccum = oArt.centroids[cIdx].map(v => v * wOld);
    for (const v of sampleHVecs) for (let i = 0; i < 355; i += 1) hAccum[i] += v[i];
    for (const v of sampleOVecs) for (let i = 0; i < 74; i += 1) oAccum[i] += v[i];
    nextH = normalized(hAccum);
    nextO = normalized(oAccum);
    nextCounts = targetModel.counts.map((c, i) => c + sampleCountsTotal[i]);
  }

  const nextWrongH = wrongCIdx >= 0 ? repelUnit(hArt.centroids[wrongCIdx], meanSampleH) : null;
  const nextWrongO = wrongCIdx >= 0 ? repelUnit(oArt.centroids[wrongCIdx], meanSampleO) : null;
  let nextWrongCounts = null;
  if (wrongModel) {
    const reduced = wrongModel.counts.map((c, i) => Math.max(0, Math.round(c - sampleCountsTotal[i])));
    const remSum = reduced.reduce((sum, v) => sum + v, 0);
    nextWrongCounts = remSum >= 355 ? reduced : wrongModel.counts.map((c) => Math.max(1, Math.round(c * 0.85)));
  }

  const nextEnvCentroids = Array.isArray(oArt.environment_centroids)
    ? oArt.environment_centroids.map(envRows => envRows.map((row, idx) => {
      if (idx === cIdx && isCorrection) return blendUnit(row, meanSampleORaw, TARGET_OVERWRITE_ALPHA);
      if (idx === wrongCIdx && isCorrection) return repelUnit(row, meanSampleORaw);
      return row;
    }))
    : oArt.environment_centroids;

  const nextBank = {
    ...bank,
    models: bank.models.map((m, idx) => {
      if (idx === modelIdx) {
        return {
          ...m,
          counts: nextCounts,
          valid_number_count: (Number(m.valid_number_count) || 0) + addedNumbers,
          verified_samples: prevVerified + cleaned.usable.length,
          ...(isCorrection ? {corrected_in_samples: (Number(m.corrected_in_samples) || 0) + cleaned.usable.length} : {}),
        };
      }
      if (idx === wrongIdx && nextWrongCounts) {
        return {
          ...m,
          counts: nextWrongCounts,
          corrected_out_samples: (Number(m.corrected_out_samples) || 0) + cleaned.usable.length,
        };
      }
      return m;
    }),
    robust: {
      ...bank.robust,
      hellinger: {
        ...hArt,
        centroids: hArt.centroids.map((r, i) => {
          if (i === cIdx) return nextH;
          if (i === wrongCIdx && nextWrongH) return nextWrongH;
          return r;
        }),
      },
      ordered_blocks: {
        ...oArt,
        centroids: oArt.centroids.map((r, i) => {
          if (i === cIdx) return nextO;
          if (i === wrongCIdx && nextWrongO) return nextWrongO;
          return r;
        }),
        environment_centroids: nextEnvCentroids,
      },
    },
  };

  let nextDetector = detector;
  const detIdx = Array.isArray(detector?.model_ids) ? detector.model_ids.indexOf(targetModel.id) : -1;
  const wrongDetIdx = wrongModel && Array.isArray(detector?.model_ids) ? detector.model_ids.indexOf(wrongModel.id) : -1;
  if (detIdx >= 0 && detector?.ranker?.bank) {
    const ranker = detector.ranker;
    const rBank = ranker.bank;
    const detSampleH = [];
    const detSampleO = [];
    const detSampleORaw = [];
    const addedRefs = [];
    const headVecs = [];
    for (const s of cleaned.usable) {
      detSampleH.push(hellingerUnitVector(s.counts, rBank.hellinger));
      detSampleO.push(orderedBlockUnitVector(s.numbers, rBank.ordered_blocks));
      detSampleORaw.push(orderedBlockCenteredRawUnit(s.numbers, rBank.ordered_blocks));
      if (Array.isArray(ranker.full_params) && ranker.full_params.length >= 2) {
        addedRefs.push(sharedDetectorRefVector(s.counts, s.numbers, ranker.full_params));
      }
      if (isCorrection && Array.isArray(ranker.head_params) && ranker.head_params.length >= 2) {
        const subNums = s.numbers.slice(0, 128);
        headVecs.push(sharedDetectorRefVector(countNumbers(subNums), subNums, ranker.head_params));
      }
    }

    const detMeanH = normalized(sumVectors(detSampleH, 355));
    const detMeanO = normalized(sumVectors(detSampleO, 74));
    const detMeanORaw = normalized(sumVectors(detSampleORaw, 74));

    let nextRh;
    let nextRo;
    if (isCorrection) {
      nextRh = blendUnit(rBank.hellinger.centroids[detIdx], detMeanH, TARGET_OVERWRITE_ALPHA);
      nextRo = blendUnit(rBank.ordered_blocks.centroids[detIdx], detMeanO, TARGET_OVERWRITE_ALPHA);
    } else {
      const rhAccum = rBank.hellinger.centroids[detIdx].map(v => v * wOld);
      const roAccum = rBank.ordered_blocks.centroids[detIdx].map(v => v * wOld);
      for (const v of detSampleH) for (let i = 0; i < 355; i += 1) rhAccum[i] += v[i];
      for (const v of detSampleO) for (let i = 0; i < 74; i += 1) roAccum[i] += v[i];
      nextRh = normalized(rhAccum);
      nextRo = normalized(roAccum);
    }

    const nextWrongRh = wrongDetIdx >= 0 && isCorrection ? repelUnit(rBank.hellinger.centroids[wrongDetIdx], detMeanH) : null;
    const nextWrongRo = wrongDetIdx >= 0 && isCorrection ? repelUnit(rBank.ordered_blocks.centroids[wrongDetIdx], detMeanO) : null;
    const nextDetEnv = Array.isArray(rBank.ordered_blocks.environment_centroids)
      ? rBank.ordered_blocks.environment_centroids.map(envRows => envRows.map((row, idx) => {
        if (idx === detIdx && isCorrection) return blendUnit(row, detMeanORaw, TARGET_OVERWRITE_ALPHA);
        if (idx === wrongDetIdx && isCorrection) return repelUnit(row, detMeanORaw);
        return row;
      }))
      : rBank.ordered_blocks.environment_centroids;

    const meanAddedRef = addedRefs.length ? normalized(sumVectors(addedRefs, 429)) : null;
    const nextRefs = Array.isArray(ranker.references)
      ? ranker.references.map((refs, i) => {
        if (!Array.isArray(refs) || !addedRefs.length) return refs;
        if (i === detIdx) {
          const extra = isCorrection
            ? [0, 1, 2].map(k => addedRefs[k % addedRefs.length].map((v, d) => Number((v + ((d % 7) - 3) * 1e-5 * (k + 1)).toFixed(7))))
            : [];
          const merged = [...refs, ...addedRefs, ...extra];
          return merged.length > MAX_REFERENCES_PER_MODEL ? merged.slice(merged.length - MAX_REFERENCES_PER_MODEL) : merged;
        }
        if (i === wrongDetIdx && isCorrection && meanAddedRef && refs.length >= 7) {
          const wrongCore = repelUnit(normalized(sumVectors(refs, 429)), meanAddedRef, 0.35);
          const ranked = refs.map((r, rIdx) => ({rIdx, dist: sqDist(r, meanAddedRef)})).sort((a, b) => a.dist - b.dist);
          const purgeSet = new Map(ranked.slice(0, Math.min(7, refs.length)).map((item, rank) => [item.rIdx, rank]));
          return refs.map((r, rIdx) => {
            if (!purgeSet.has(rIdx)) return r;
            const rank = purgeSet.get(rIdx);
            const cleanedRow = repelUnit(r, meanAddedRef, 0.48);
            return cleanedRow.map((v, d) => Number((0.5 * v + 0.5 * wrongCore[d] + ((d % 11) - 5) * 1e-4 * (rank + 1)).toFixed(7)));
          });
        }
        return refs;
      })
      : ranker.references;

    let nextLdaWeights = ranker.lda_weights;
    if (isCorrection && headVecs.length && Array.isArray(ranker.lda_weights)) {
      const meanHead = normalized(sumVectors(headVecs, 429));
      nextLdaWeights = ranker.lda_weights.map((row, idx) => {
        if (idx !== detIdx && idx !== wrongDetIdx) return row;
        const rowNorm = Math.max(Math.sqrt(dot(row, row)), 1);
        const shift = idx === detIdx ? 0.9 * rowNorm : -0.7 * rowNorm;
        return row.map((v, d) => Number((v + shift * meanHead[d]).toFixed(7)));
      });
    }

    nextDetector = {
      ...detector,
      ranker: {
        ...ranker,
        lda_weights: nextLdaWeights,
        references: nextRefs,
        bank: {
          ...rBank,
          hellinger: {
            ...rBank.hellinger,
            centroids: rBank.hellinger.centroids.map((r, i) => {
              if (i === detIdx) return nextRh;
              if (i === wrongDetIdx && nextWrongRh) return nextWrongRh;
              return r;
            }),
          },
          ordered_blocks: {
            ...rBank.ordered_blocks,
            centroids: rBank.ordered_blocks.centroids.map((r, i) => {
              if (i === detIdx) return nextRo;
              if (i === wrongDetIdx && nextWrongRo) return nextWrongRo;
              return r;
            }),
            environment_centroids: nextDetEnv,
          },
        },
      },
    };
  }

  return {
    bank: nextBank,
    detector: nextDetector,
    modelId: targetModel.id,
    displayName: targetModel.display_name,
    corrected: isCorrection,
    overwrittenWrongModelId: wrongModel ? wrongModel.id : null,
    overwrittenWrongDisplayName: wrongModel ? wrongModel.display_name : null,
    addedSamples: cleaned.usable.length,
    totalSamples: wOld + cleaned.usable.length,
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8'},
  });
}

async function commitAssimilatedSample({repo, branch = 'main', token, cleaned, fetchImpl = fetch}) {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'yf-probe-bank-relay/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const ghApi = async (ep, method = 'GET', body = null) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${ep}`, {
      method,
      headers: ghHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  const encoder = new TextEncoder();
  const sampleCanonical = JSON.stringify({
    samples: cleaned.usable.map(s => ({expected_count: s.expected_count, numbers: s.numbers})),
  });
  const shaSeed = cleaned.isCorrection
    ? `correct:${cleaned.wrongModelId || cleaned.wrongDisplayName || ''}->${cleaned.modelId}:${sampleCanonical}`
    : `${cleaned.modelId}:${sampleCanonical}`;
  const sampleSha = await sha256Hex(encoder.encode(shaSeed));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refRes = await ghApi(`/git/ref/heads/${branch}`);
    if (!refRes.ok) throw new Error(`读取云端分支失败 (HTTP ${refRes.status})`);
    const parentSha = (await refRes.json()).object.sha;

    const commitRes = await ghApi(`/git/commits/${parentSha}`);
    if (!commitRes.ok) throw new Error(`读取云端提交失败 (HTTP ${commitRes.status})`);
    const baseTreeSha = (await commitRes.json()).tree.sha;

    const rawBase = `https://raw.githubusercontent.com/${repo}/${parentSha}`;
    const [bankRes, detRes, manRes] = await Promise.all([
      fetchImpl(`${rawBase}/data/unified_bank.json`),
      fetchImpl(`${rawBase}/data/shared_detector.json`),
      fetchImpl(`${rawBase}/data/bank-manifest.json`),
    ]);
    if (!bankRes.ok || !detRes.ok || !manRes.ok) {
      throw new Error('拉取云端基准指纹库失败');
    }
    const [bank, detector, manifest] = await Promise.all([
      bankRes.json(),
      detRes.json(),
      manRes.json(),
    ]);

    const evolved = evolvePair(bank, detector, cleaned);
    const safeDir = evolved.modelId.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const archiveRelPath = cleaned.isCorrection
      ? `corrections/${safeDir}/${sampleSha.slice(0, 20)}.json`
      : `samples/${safeDir}/${sampleSha.slice(0, 20)}.json`;

    const dupRes = await ghApi(`/contents/${archiveRelPath}?ref=${parentSha}`);
    if (dupRes.status === 200) {
      return {
        ok: true,
        duplicate: true,
        corrected: evolved.corrected,
        repo,
        commit: parentSha,
        version: manifest.version,
        modelId: evolved.modelId,
        displayName: evolved.displayName,
        overwrittenWrongModelId: evolved.overwrittenWrongModelId,
        totalSamples: evolved.totalSamples - evolved.addedSamples,
      };
    }

    const bankText = JSON.stringify(evolved.bank);
    const detText = JSON.stringify(evolved.detector);
    const bankBytes = encoder.encode(bankText);
    const detBytes = encoder.encode(detText);
    const [bankSha, detSha] = await Promise.all([sha256Hex(bankBytes), sha256Hex(detBytes)]);

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const prevVer = String(manifest.version || '');
    const nextVer = prevVer.startsWith(today + '.')
      ? `${today}.${(Number(prevVer.slice(today.length + 1)) || 0) + 1}`
      : `${today}.1`;

    const nextManifestText = JSON.stringify({
      ...manifest,
      version: nextVer,
      updated_at: new Date().toISOString(),
      verified_uploads: (Number(manifest.verified_uploads) || 0) + evolved.addedSamples,
      ...(evolved.corrected ? {corrected_uploads: (Number(manifest.corrected_uploads) || 0) + evolved.addedSamples} : {}),
      files: {
        ...manifest.files,
        'data/unified_bank.json': {size: bankBytes.byteLength, sha256: bankSha},
        'data/shared_detector.json': {size: detBytes.byteLength, sha256: detSha},
      },
    }, null, 2) + '\n';

    const archiveText = JSON.stringify({
      schema: evolved.corrected ? 'yf-corrected-sample-v1' : 'yf-verified-sample-v1',
      assimilated_at: new Date().toISOString(),
      model_id: evolved.modelId,
      display_name: evolved.displayName,
      ...(evolved.corrected ? {
        corrected: true,
        overwrite: true,
        overwritten_wrong_model_id: evolved.overwrittenWrongModelId,
        overwritten_wrong_display_name: cleaned.wrongDisplayName || evolved.overwrittenWrongDisplayName || null,
      } : {}),
      sample_sha256: sampleSha,
      client_version: cleaned.clientVersion,
      samples: cleaned.usable.map(s => ({expected_count: s.expected_count, numbers: s.numbers})),
    }, null, 2) + '\n';

    const toPost = [
      ['data/unified_bank.json', bankText],
      ['data/shared_detector.json', detText],
      ['data/bank-manifest.json', nextManifestText],
      [archiveRelPath, archiveText],
    ];
    const treeItems = [];
    for (const [p, content] of toPost) {
      const bRes = await ghApi('/git/blobs', 'POST', {content, encoding: 'utf-8'});
      if (!bRes.ok) throw new Error(`上传云端数据块失败 (${p}: HTTP ${bRes.status})`);
      const bJson = await bRes.json();
      treeItems.push({path: p, mode: '100644', type: 'blob', sha: bJson.sha});
    }

    // If correcting a wrong model, also purge any prior mistaken sample file for that wrong model if present
    if (evolved.corrected && evolved.overwrittenWrongModelId) {
      const oldWrongSha = await sha256Hex(encoder.encode(`${evolved.overwrittenWrongModelId}:${sampleCanonical}`));
      const wrongSafeDir = evolved.overwrittenWrongModelId.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const wrongRelPath = `samples/${wrongSafeDir}/${oldWrongSha.slice(0, 20)}.json`;
      const oldCheck = await ghApi(`/contents/${wrongRelPath}?ref=${parentSha}`);
      if (oldCheck.status === 200) {
        treeItems.push({path: wrongRelPath, mode: '100644', type: 'blob', sha: null});
      }
    }

    const tRes = await ghApi('/git/trees', 'POST', {base_tree: baseTreeSha, tree: treeItems});
    if (!tRes.ok) throw new Error(`构建云端目录树失败 (HTTP ${tRes.status})`);
    const newTreeSha = (await tRes.json()).sha;

    const commitMsg = evolved.corrected
      ? `fix(bank): correct ${evolved.overwrittenWrongModelId || 'misidentified'} -> ${evolved.modelId} and overwrite wrong fingerprint [${nextVer}]`
      : `chore(bank): assimilate verified ${evolved.modelId} (+${evolved.addedSamples} sample) [${nextVer}]`;

    const cRes = await ghApi('/git/commits', 'POST', {
      message: commitMsg,
      tree: newTreeSha,
      parents: [parentSha],
    });
    if (!cRes.ok) throw new Error(`创建云端提交失败 (HTTP ${cRes.status})`);
    const newCommitSha = (await cRes.json()).sha;

    const uRes = await ghApi(`/git/refs/heads/${branch}`, 'PATCH', {sha: newCommitSha, force: false});
    if (uRes.ok) {
      return {
        ok: true,
        assimilated: true,
        corrected: evolved.corrected,
        repo,
        commit: newCommitSha,
        version: nextVer,
        modelId: evolved.modelId,
        displayName: evolved.displayName,
        overwrittenWrongModelId: evolved.overwrittenWrongModelId,
        addedSamples: evolved.addedSamples,
        totalSamples: evolved.totalSamples,
      };
    }
    if (uRes.status !== 422 && uRes.status !== 409) {
      throw new Error(`更新云端分支失败 (HTTP ${uRes.status})`);
    }
  }
  throw new Error('云端并发写入冲突，请稍后重试');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: CORS_HEADERS});
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/v1/fingerprints')) {
      return jsonResponse({
        ok: true,
        service: 'yf-probe-bank-relay',
        mode: 'direct-atomic-assimilation',
        repo: env?.GITHUB_REPO || 'lishuai835/yf-probe-bank',
      });
    }
    if (request.method !== 'POST' || !['/api/v1/fingerprints', '/submit', '/'].includes(url.pathname)) {
      return jsonResponse({ok: false, error: 'Not Found'}, 404);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (!checkRateLimit(ip)) {
      return jsonResponse({ok: false, error: '上传过于频繁，请稍后再试'}, 429);
    }

    const rawText = await request.text();
    if (rawText.length > 48_000) {
      return jsonResponse({ok: false, error: '数据包体积超限'}, 413);
    }

    let cleaned;
    try {
      cleaned = validateIncomingPayload(JSON.parse(rawText));
    } catch (err) {
      return jsonResponse({ok: false, error: err.message || '指纹样本校验未通过'}, 400);
    }

    const token = env?.GITHUB_TOKEN;
    if (!token) {
      return jsonResponse({ok: false, error: '中转服务端尚未配置 GITHUB_TOKEN'}, 500);
    }

    try {
      const result = await commitAssimilatedSample({
        repo: env.GITHUB_REPO || 'lishuai835/yf-probe-bank',
        branch: env.GITHUB_BRANCH || 'main',
        token,
        cleaned,
        fetchImpl: env.fetchImpl || fetch,
      });
      return jsonResponse(result, 200);
    } catch (err) {
      return jsonResponse({ok: false, error: err.message || '云端指纹库融合写入失败'}, 502);
    }
  },
};
