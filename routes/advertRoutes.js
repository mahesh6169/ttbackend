import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import { multerMiddleware } from '../middlewares/multerConfig.js';
import {
  deleteAdvert,
  renewAdvert,
  toggleAdvertGoLive,
  fetchMyAdverts,
  addAdvert,
    updateAdvert,
    getAdvertById,
    getSitemapAdverts,
} from '../controllers/adverts/advertController.js';

  
  import {
    searchAdverts,
    getFilterOptions,
} from '../controllers/adverts/searchAdvertsController.js'; 

const router = express.Router();



router.get('/search', searchAdverts);
router.get('/filter-options', getFilterOptions);
router.get('/sitemap', getSitemapAdverts);

router.post('/addAdvert', authMiddleware,  multerMiddleware,  addAdvert);
router.put(  '/updateAdvert/:id',  authMiddleware,  multerMiddleware,  updateAdvert);
router.get('/byid/:id', getAdvertById); // Fetch a single advert by ID

// Protected Routes
router.get('/myadverts', authMiddleware, fetchMyAdverts); // Fetch all adverts by user
router.delete('/delete/:id', authMiddleware, deleteAdvert); // Delete an advert
router.put('/renew/:id', authMiddleware, renewAdvert); // Renew an advert
router.patch('/:id/toggle-golive', authMiddleware, toggleAdvertGoLive); // Toggle Live/Offline visibility

export default router