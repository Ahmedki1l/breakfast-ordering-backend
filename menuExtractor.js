import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

const EXTRACTION_PROMPT = `You are an expert at reading Egyptian restaurant menus. Analyze this menu image with extreme care and extract EVERY item with correct prices.

IMPORTANT CONTEXT:
- These are typically Egyptian breakfast/foul restaurants.
- Menus are in Arabic (RTL). The image may be rotated — read in whatever orientation makes the text correct.
- Menus are divided into SECTIONS with styled header bars (often colored backgrounds with contrasting text).
- Many sections use a DUAL-COLUMN price format with column headers like "صغير" (small) and "كبير" (large), or "شامي" (shami bread) and "بلدي" (baladi bread). Each item row has prices under each column.
- Some sections have only a single price per item.

Return a JSON object with this EXACT structure. Here is a REAL EXAMPLE showing how multiple sections should be extracted:
{
  "items": [
    {"name": "فول سادة", "category": "علب فول", "variants": [{"label": "صغير", "price": 11}, {"label": "كبير", "price": 14}]},
    {"name": "فول حار", "category": "علب فول", "variants": [{"label": "صغير", "price": 12}, {"label": "كبير", "price": 15}]},
    {"name": "فول زيت زيتون", "category": "علب فول", "variants": [{"label": "صغير", "price": 12}, {"label": "كبير", "price": 15}]},
    {"name": "فول بيض مسلوق", "category": "علب فول", "variants": [{"label": "صغير", "price": 12}, {"label": "كبير", "price": 15}]},
    {"name": "فول أومليت", "category": "علب فول", "variants": [{"label": "صغير", "price": 19}]},
    {"name": "فول بسطرمه", "category": "علب فول", "variants": [{"label": "صغير", "price": 15}, {"label": "كبير", "price": 19}]},
    {"name": "بيضه مسلوقه", "category": "علب بيض", "variants": [{"label": "default", "price": 9}]},
    {"name": "بيضه مسلوق زيت و طحينة", "category": "علب بيض", "variants": [{"label": "default", "price": 14}]},
    {"name": "بيض أو مليت", "category": "علب بيض", "variants": [{"label": "default", "price": 18}]},
    {"name": "بيض بسطرمه", "category": "علب بيض", "variants": [{"label": "default", "price": 23}]},
    {"name": "بيض سوسيس", "category": "علب بيض", "variants": [{"label": "default", "price": 20}]},
    {"name": "قرص طعمية", "category": "ركن متنوع", "variants": [{"label": "صغير", "price": 3}, {"label": "كبير", "price": 3}]},
    {"name": "قرص طعمية محشية", "category": "ركن متنوع", "variants": [{"label": "صغير", "price": 5}, {"label": "كبير", "price": 8}]},
    {"name": "طرشى بلدى", "category": "مخلل", "variants": [{"label": "صغير", "price": 6}, {"label": "كبير", "price": 10}]},
    {"name": "علبه طحينة", "category": "مخلل", "variants": [{"label": "صغير", "price": 10}, {"label": "كبير", "price": 13}]},
    {"name": "فول سادة", "category": "ساندويتشات فول", "variants": [{"label": "شامي", "price": 10}, {"label": "بلدي", "price": 8}]},
    {"name": "فول زيت زيتون", "category": "ساندويتشات فول", "variants": [{"label": "شامي", "price": 13}, {"label": "بلدي", "price": 11}]},
    {"name": "وجبه بسكوته", "category": "وجبات", "variants": [{"label": "default", "price": 60}]}
  ]
}

NOTICE in the example above:
- "علب فول" and "ساندويتشات فول" are SEPARATE categories (even though both are foul items)
- "علب فول" uses صغير/كبير variants, while "ساندويتشات فول" uses شامي/بلدي variants (different column headers per section!)
- "علب بيض" has single-price items ("default" label)
- "فول أومليت" only has a صغير price (no كبير) — only include the variant that exists
- "وجبه بسكوته" is a single meal — goes under "وجبات" with "default" label

RULES:

1. CATEGORIES:
   - Derive a CLEAN, SHORT, READABLE category name from each section header on the menu.
   - Remove unnecessary "ال" (definite article) to keep names short: "علب الفول" → "علب فول", "ساندويتشات البيض" → "ساندويتشات بيض"
   - Keep categories DISTINCT. Each menu section = its own separate category. NEVER merge different sections.
   - Example: "علب الفول" → "علب فول", "ساندويتشات الفول" → "ساندويتشات فول" (TWO separate categories, NOT both as "فول")
   - For single-item sections like "وجبه بسكوته", use a general category like "وجبات"

2. DUAL-COLUMN PRICES → VARIANTS:
   - If a section has TWO price columns (e.g. صغير/كبير or شامي/بلدي), read the column headers and create a variant for EACH column:
     "variants": [{"label": "صغير", "price": 11}, {"label": "كبير", "price": 14}]
   - The column headers vary by section. Read them from the TOP of each section's price area.
   - If the column headers are bread types (شامي/بلدي/فينو), use those as variant labels.
   - If an item only has a price in ONE column, include only that variant.

3. SINGLE PRICE ITEMS:
   - If an item has only one price and no size/column options: "variants": [{"label": "default", "price": 60}]

4. ITEM NAMES:
   - Copy the Arabic item name EXACTLY as written on the menu.
   - Include full descriptions (e.g. "فول بيض مسلوق" not just "فول").
   - Do NOT abbreviate or translate names.

5. COMPLETENESS:
   - Extract EVERY item from EVERY section. Do not skip any.
   - If the menu has multiple pages/sides, extract from ALL visible pages.
   - Include addon sections (إضافات), pickle sections (مخلل), drink sections (مشروبات), etc.

6. Prices must be numbers, not strings.
7. Return ONLY valid JSON, no markdown or extra text.`;

const MENU_FROM_PHOTOS_PROMPT = `You are an expert at reading Egyptian restaurant menus. These are photos from a restaurant.
Some photos may be menu images, some may be food photos, and some may be interior/exterior shots.

IMPORTANT CONTEXT:
- These are typically Egyptian breakfast/foul restaurants.
- Menus are in Arabic (RTL). Photos may be rotated — read in whatever orientation makes the text correct.
- Menus are divided into SECTIONS with styled header bars (often colored backgrounds with contrasting text).
- Many sections use a DUAL-COLUMN price format with column headers like "صغير" (small) and "كبير" (large), or "شامي" and "بلدي". Each item row has prices under each column.

Your job:
1. Look at ALL the photos
2. If any photo shows a MENU (with items and prices), extract ALL items from it
3. If photos show FOOD DISHES but no menu/prices, try to identify the dish names
4. Ignore photos that are not food or menu related

Return a JSON object with this EXACT structure. Here is a REAL EXAMPLE showing how multiple sections should be extracted:
{
  "items": [
    {"name": "فول سادة", "category": "علب فول", "variants": [{"label": "صغير", "price": 11}, {"label": "كبير", "price": 14}]},
    {"name": "فول حار", "category": "علب فول", "variants": [{"label": "صغير", "price": 12}, {"label": "كبير", "price": 15}]},
    {"name": "بيضه مسلوقه", "category": "علب بيض", "variants": [{"label": "default", "price": 9}]},
    {"name": "بيض بسطرمه", "category": "علب بيض", "variants": [{"label": "default", "price": 23}]},
    {"name": "قرص طعمية محشية", "category": "ركن متنوع", "variants": [{"label": "صغير", "price": 5}, {"label": "كبير", "price": 8}]},
    {"name": "فول سادة", "category": "ساندويتشات فول", "variants": [{"label": "شامي", "price": 10}, {"label": "بلدي", "price": 8}]},
    {"name": "طرشى بلدى", "category": "مخلل", "variants": [{"label": "صغير", "price": 6}, {"label": "كبير", "price": 10}]},
    {"name": "وجبه بسكوته", "category": "وجبات", "variants": [{"label": "default", "price": 60}]}
  ],
  "source": "menu"
}

NOTICE in the example above:
- "علب فول" and "ساندويتشات فول" are SEPARATE categories (both foul, but different sections!)
- "علب فول" uses صغير/كبير variants, "ساندويتشات فول" uses شامي/بلدي (different columns per section!)
- "علب بيض" has single-price items ("default" label)
- "وجبه بسكوته" single fixed price under "وجبات" category

RULES:
- If you found a menu with prices, set source to "menu"
- If you could only identify food from photos (no prices), set price to 0 and source to "photos"
- If no food/menu content found, return {"items": [], "source": "none"}

- CATEGORIES:
  - Derive a CLEAN, SHORT, READABLE category name from each section header on the menu.
  - Remove unnecessary "ال" (definite article): "علب الفول" → "علب فول", "ساندويتشات البيض" → "ساندويتشات بيض"
  - Keep categories DISTINCT. NEVER merge different sections into one category.
  - For single-item sections use a general category like "وجبات"

- DUAL-COLUMN PRICES → VARIANTS:
  - If a section has TWO price columns (e.g. صغير/كبير or شامي/بلدي), create a variant for each column.
  - Read the column header labels from the top of each section.
  - If columns are bread types (شامي/بلدي/فينو), use those as variant labels.

- SINGLE PRICE: use "variants": [{"label": "default", "price": X}]
- Copy Arabic item names EXACTLY — do not abbreviate or translate.
- Extract EVERY item from EVERY section. Do not skip any.
- Prices must be numbers.
- Return ONLY valid JSON.`;

export async function extractMenuFromImage(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  
  // Detect mime type from extension
  const ext = imagePath.toLowerCase().split('.').pop();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const mimeType = mimeMap[ext] || 'image/jpeg';

  const parts = [
    EXTRACTION_PROMPT,
    {
      inlineData: {
        data: base64Image,
        mimeType
      }
    }
  ];

  // Retry with exponential backoff for 500/429 errors
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await model.generateContent(parts);
      break;
    } catch (err) {
      const status = err.status || err.httpStatusCode;
      if ((status === 429 || status === 500 || status === 503) && attempt < 3) {
        const delay = attempt * 3000;
        console.log(`  Gemini error ${status}, retrying in ${delay / 1000}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  const response = result.response;
  const text = response.text();
  
  // Parse JSON from response (strip markdown code fences if present)
  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
  }
  
  const parsed = JSON.parse(jsonText.trim());
  
  // Validate structure
  if (!parsed.items || !Array.isArray(parsed.items)) {
    throw new Error('AI response missing items array');
  }
  
  // Sanitize and validate each item
  return parsed.items.map(item => ({
    name: String(item.name || '').trim(),
    category: String(item.category || 'Uncategorized').trim(),
    variants: (item.variants || []).map(v => ({
      label: String(v.label || 'default').trim(),
      price: Number(v.price) || 0
    })).filter(v => v.price > 0 && v.label)
  })).filter(item => item.name && item.variants.length > 0);
}

/**
 * Extract menu from Google Maps photo URLs.
 * Downloads images and sends them ALL to Gemini in one request.
 */
export async function extractMenuFromUrls(imageUrls) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('No image URLs provided');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Download all images in parallel
  const imagePromises = imageUrls.map(async (url, idx) => {
    try {
      console.log(`  Downloading photo ${idx + 1}/${imageUrls.length}: ${url.substring(0, 80)}...`);
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
          'Referer': process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}/`,
        }
      });
      if (!response.ok) {
        console.log(`  Photo ${idx + 1} failed: HTTP ${response.status}`);
        return null;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 1000) {
        console.log(`  Photo ${idx + 1} too small (${buffer.byteLength} bytes), skipping`);
        return null;
      }
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      console.log(`  Photo ${idx + 1} downloaded: ${(buffer.byteLength / 1024).toFixed(0)}KB, ${contentType}`);
      const base64 = Buffer.from(buffer).toString('base64');
      return { data: base64, mimeType: contentType.split(';')[0] };
    } catch (err) {
      console.log(`  Photo ${idx + 1} error: ${err.message}`);
      return null;
    }
  });

  const images = (await Promise.all(imagePromises)).filter(Boolean);
  console.log(`  Downloaded ${images.length}/${imageUrls.length} photos successfully`);

  if (images.length === 0) {
    throw new Error('Could not download any images. The Google Maps photo URLs may require browser authentication.');
  }

  const parts = [
    MENU_FROM_PHOTOS_PROMPT,
    ...images.map(img => ({
      inlineData: img
    }))
  ];

  // Retry with backoff for rate limits
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const delay = (attempt * 20) * 1000; // 20s, 40s
        console.log(`  Gemini rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, delay));
      }
      const result = await model.generateContent(parts);
      const text = result.response.text();

      let jsonText = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonText = jsonMatch[1];

      const parsed = JSON.parse(jsonText.trim());

      if (!parsed.items || !Array.isArray(parsed.items)) {
        throw new Error('AI response missing items array');
      }

      return {
        items: parsed.items.map(item => ({
          name: String(item.name || '').trim(),
          category: String(item.category || 'Uncategorized').trim(),
          variants: (item.variants || []).map(v => ({
            label: String(v.label || 'default').trim(),
            price: Number(v.price) || 0
          })).filter(v => v.label)
        })).filter(item => item.name),
        source: parsed.source || 'unknown'
      };
    } catch (err) {
      lastError = err;
      if (err.status !== 429 && !err.message?.includes('429')) break;
    }
  }
  throw lastError || new Error('Failed after retries');
}

/**
 * Extract menu from pre-downloaded base64 images.
 * Images are downloaded in the browser and sent as base64 data.
 */
export async function extractMenuFromBase64(images) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  if (!images || images.length === 0) {
    throw new Error('No images provided');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const parts = [
    MENU_FROM_PHOTOS_PROMPT,
    ...images.map(img => ({
      inlineData: {
        data: img.data,
        mimeType: img.mimeType || 'image/jpeg'
      }
    }))
  ];

  const result = await model.generateContent(parts);
  const text = result.response.text();

  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1];

  const parsed = JSON.parse(jsonText.trim());

  if (!parsed.items || !Array.isArray(parsed.items)) {
    throw new Error('AI response missing items array');
  }

  return {
    items: parsed.items.map(item => ({
      name: String(item.name || '').trim(),
      category: String(item.category || 'Uncategorized').trim(),
      variants: (item.variants || []).map(v => ({
        label: String(v.label || 'default').trim(),
        price: Number(v.price) || 0
      })).filter(v => v.label)
    })).filter(item => item.name),
    source: parsed.source || 'unknown'
  };
}
