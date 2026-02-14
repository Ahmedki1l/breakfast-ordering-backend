import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { extractMenuFromImage, extractMenuFromUrls, extractMenuFromBase64 } from './menuExtractor.js';

const router = express.Router();

// ============ Data Persistence ============
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'restaurants.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function loadRestaurants() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading restaurants:', e.message);
  }
  return [];
}

function saveRestaurants(restaurants) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(restaurants, null, 2), 'utf-8');
}

// ============ Multer Setup ============
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `menu-${nanoid(8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype.split('/')[1]);
    cb(null, extOk && mimeOk);
  }
});

// ============ Public Routes ============

// List all restaurants (for host dropdown)
router.get('/api/restaurants', (req, res) => {
  const restaurants = loadRestaurants();
  // Return simplified data for the dropdown
  res.json(restaurants.map(r => ({
    id: r.id,
    name: r.name,
    address: r.address,
    menuItemCount: r.menuItems?.length || 0
  })));
});

// Get restaurant with full menu
router.get('/api/restaurants/:id', (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  res.json(restaurant);
});

// ============ Admin Routes ============

// List all restaurants (full data)
router.get('/api/admin/restaurants', (req, res) => {
  res.json(loadRestaurants());
});

// Create restaurant
router.post('/api/admin/restaurants', (req, res) => {
  const { name, address, googleMapsUrl, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Restaurant name is required' });

  const restaurants = loadRestaurants();
  const restaurant = {
    id: nanoid(8),
    name: name.trim(),
    address: (address || '').trim(),
    googleMapsUrl: (googleMapsUrl || '').trim(),
    phone: (phone || '').trim(),
    menuImages: [],
    menuItems: [],
    createdAt: new Date().toISOString()
  };

  restaurants.push(restaurant);
  saveRestaurants(restaurants);
  res.json(restaurant);
});

// Update restaurant info
router.put('/api/admin/restaurants/:id', (req, res) => {
  const restaurants = loadRestaurants();
  const idx = restaurants.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Restaurant not found' });

  const { name, address, googleMapsUrl, phone } = req.body;
  if (name !== undefined) restaurants[idx].name = name.trim();
  if (address !== undefined) restaurants[idx].address = address.trim();
  if (googleMapsUrl !== undefined) restaurants[idx].googleMapsUrl = googleMapsUrl.trim();
  if (phone !== undefined) restaurants[idx].phone = phone.trim();

  saveRestaurants(restaurants);
  res.json(restaurants[idx]);
});

// Delete restaurant
router.delete('/api/admin/restaurants/:id', (req, res) => {
  let restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  // Clean up uploaded images
  (restaurant.menuImages || []).forEach(img => {
    const imgPath = path.join(UPLOADS_DIR, img);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  });

  restaurants = restaurants.filter(r => r.id !== req.params.id);
  saveRestaurants(restaurants);
  res.json({ success: true });
});

// Upload menu image
router.post('/api/admin/restaurants/:id/menu-image', upload.single('menuImage'), (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  restaurant.menuImages.push(req.file.filename);
  saveRestaurants(restaurants);
  res.json({ filename: req.file.filename, restaurant });
});

// Delete menu image
router.delete('/api/admin/restaurants/:id/menu-image/:filename', (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const imgPath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  restaurant.menuImages = restaurant.menuImages.filter(f => f !== req.params.filename);
  saveRestaurants(restaurants);
  res.json({ success: true });
});

// Extract menu from image using AI
router.post('/api/admin/restaurants/:id/extract-menu', async (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { imageFilename } = req.body;
  if (!imageFilename) return res.status(400).json({ error: 'imageFilename is required' });

  const imgPath = path.join(UPLOADS_DIR, imageFilename);
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Image file not found' });

  try {
    const items = await extractMenuFromImage(imgPath);
    // Add IDs to extracted items
    const itemsWithIds = items.map(item => ({ ...item, id: nanoid(6) }));
    res.json({ items: itemsWithIds });
  } catch (err) {
    console.error('Menu extraction error:', err);
    res.status(500).json({ error: 'Failed to extract menu: ' + err.message });
  }
});

// Extract menu from Google Maps photo URLs
router.post('/api/admin/restaurants/:id/extract-menu-from-urls', async (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { photoUrls } = req.body;
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
    return res.status(400).json({ error: 'photoUrls array is required' });
  }

  try {
    const result = await extractMenuFromUrls(photoUrls);
    const itemsWithIds = result.items.map(item => ({ ...item, id: nanoid(6) }));
    res.json({ items: itemsWithIds, source: result.source });
  } catch (err) {
    console.error('URL menu extraction error:', err);
    res.status(500).json({ error: 'Failed to extract menu: ' + err.message });
  }
});

// Extract menu from base64 images (downloaded in browser)
router.post('/api/admin/restaurants/:id/extract-menu-from-photos', async (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { images } = req.body; // [{ data: base64, mimeType: 'image/jpeg' }]
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images array is required (base64 data)' });
  }

  try {
    const result = await extractMenuFromBase64(images);
    const itemsWithIds = result.items.map(item => ({ ...item, id: nanoid(6) }));
    res.json({ items: itemsWithIds, source: result.source });
  } catch (err) {
    console.error('Photo menu extraction error:', err);
    res.status(500).json({ error: 'Failed to extract menu: ' + err.message });
  }
});

// Fetch structured menu from Google Places REST API (businessMenus field)
router.post('/api/admin/restaurants/:id/fetch-google-menu', async (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { placeId } = req.body;
  if (!placeId) return res.status(400).json({ error: 'placeId is required' });

  const gmapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!gmapsKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set' });

  try {
    console.log(`Fetching businessMenus for place: ${placeId}`);
    const apiUrl = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await fetch(apiUrl, {
      headers: {
        'X-Goog-FieldMask': 'foodMenus',
        'X-Goog-Api-Key': gmapsKey,
        'Referer': process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}/`,
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Places API error:', response.status, errText);
      return res.status(response.status).json({ error: `Places API error: ${response.status}`, details: errText });
    }

    const data = await response.json();
    console.log('Places API response:', JSON.stringify(data, null, 2));

    // Parse the foodMenus/businessMenus structure into our menu item format
    const items = [];
    const menus = data.foodMenus || data.businessMenus || [];
    
    for (const menu of menus) {
      const sections = menu.sections || menu.menuSections || [];
      for (const section of sections) {
        const categoryName = section.displayName?.text || section.sectionName || 'Uncategorized';
        const menuItems = section.items || section.menuItems || [];
        for (const item of menuItems) {
          const itemName = item.displayName?.text || item.itemName || '';
          if (!itemName) continue;

          const variants = [];
          // Check for price
          const price = item.price;
          if (price) {
            variants.push({
              label: 'default',
              price: parseFloat(price.units || 0) + parseFloat(price.nanos || 0) / 1e9
            });
          }
          // Check for options/variants
          const options = item.options || item.menuItemOptions || [];
          for (const opt of options) {
            const optName = opt.displayName?.text || opt.optionName || 'default';
            const optPrice = opt.price;
            if (optPrice) {
              variants.push({
                label: optName,
                price: parseFloat(optPrice.units || 0) + parseFloat(optPrice.nanos || 0) / 1e9
              });
            }
          }

          if (variants.length === 0) {
            variants.push({ label: 'default', price: 0 });
          }

          items.push({
            id: nanoid(6),
            name: itemName,
            category: categoryName,
            variants
          });
        }
      }
    }

    res.json({
      items,
      source: items.length > 0 ? 'google_menu' : 'none',
      rawMenus: menus.length,
      rawData: data
    });
  } catch (err) {
    console.error('Fetch Google menu error:', err);
    res.status(500).json({ error: 'Failed to fetch Google menu: ' + err.message });
  }
});

// Save menu items (replaces entire menu)
router.put('/api/admin/restaurants/:id/menu-items', (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

  // Validate and clean items
  restaurant.menuItems = items.map(item => ({
    id: item.id || nanoid(6),
    name: (item.name || '').trim(),
    category: (item.category || 'Uncategorized').trim(),
    variants: (item.variants || []).map(v => ({
      label: (v.label || 'default').trim(),
      price: Number(v.price) || 0
    })).filter(v => v.price > 0)
  })).filter(item => item.name && item.variants.length > 0);

  saveRestaurants(restaurants);
  res.json(restaurant);
});

// Add single menu item
router.post('/api/admin/restaurants/:id/menu-items', (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { name, category, variants } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });

  const item = {
    id: nanoid(6),
    name: name.trim(),
    category: (category || 'Uncategorized').trim(),
    variants: (variants || [{ label: 'default', price: 0 }]).map(v => ({
      label: (v.label || 'default').trim(),
      price: Number(v.price) || 0
    })).filter(v => v.price > 0)
  };

  if (!restaurant.menuItems) restaurant.menuItems = [];
  restaurant.menuItems.push(item);
  saveRestaurants(restaurants);
  res.json(item);
});

// Delete menu item
router.delete('/api/admin/restaurants/:id/menu-items/:itemId', (req, res) => {
  const restaurants = loadRestaurants();
  const restaurant = restaurants.find(r => r.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  restaurant.menuItems = (restaurant.menuItems || []).filter(i => i.id !== req.params.itemId);
  saveRestaurants(restaurants);
  res.json({ success: true });
});

// Serve uploaded images
router.use('/api/uploads', express.static(UPLOADS_DIR));

export default router;
