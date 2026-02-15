import mongoose from 'mongoose';

const variantSchema = new mongoose.Schema({
  label: { type: String, default: 'default', trim: true },
  price: { type: Number, default: 0 },
}, { _id: false });

const menuItemSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, default: 'Uncategorized', trim: true },
  variants: [variantSchema],
}, { _id: false });

const restaurantSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  name: { type: String, required: true, trim: true },
  address: { type: String, default: '', trim: true },
  googleMapsUrl: { type: String, default: '', trim: true },
  phone: { type: String, default: '', trim: true },
  menuImages: [String],
  menuItems: [menuItemSchema],
  createdAt: { type: Date, default: Date.now },
});

const Restaurant = mongoose.model('Restaurant', restaurantSchema);
export default Restaurant;
