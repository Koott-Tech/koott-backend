const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

const mapRowToBackend = (row) => ({
  id: row.id,
  slug: row.slug,
  status: row.is_published ? 'published' : 'draft',
  seo_title: row.content?.seo_title || row.title || null,
  seo_description: row.content?.seo_description || null,
  canonical_url: row.content?.canonical_url || null,
  cms_data: row.content?.cms_data || {},
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const getPublicBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const { preview } = req.query;

    let q = supabaseAdmin.from('event_pages').select('*').eq('slug', slug);
    if (!preview) q = q.eq('is_published', true);

    const { data: row, error } = await q.single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Event page not found'));
      }
      if (String(error.message || '').includes('does not exist')) {
        return res.status(503).json(
          errorResponse('Event pages are not set up. Run backend/scripts/create-event-pages.sql in Supabase.')
        );
      }
      console.error('getPublicBySlug event_pages:', error);
      return res.status(500).json(errorResponse('Failed to load event page', error.message));
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json(successResponse(mapRowToBackend(row), 'OK'));
  } catch (e) {
    console.error('getPublicBySlug', e);
    res.status(500).json(errorResponse('Failed to load event page', e.message));
  }
};

const listPublic = async (req, res) => {
  try {
    const { limit = 24 } = req.query;
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 24, 100));

    const { data, error } = await supabaseAdmin
      .from('event_pages')
      .select('*')
      .eq('is_published', true)
      .order('updated_at', { ascending: false })
      .limit(lim);

    if (error) {
      if (String(error.message || '').includes('does not exist')) {
        return res.status(503).json(
          errorResponse('Event pages are not set up. Run backend/scripts/create-event-pages.sql in Supabase.')
        );
      }
      console.error('listPublic event_pages:', error);
      return res.status(500).json(errorResponse('Failed to list event pages', error.message));
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json(successResponse((data || []).map(mapRowToBackend), 'OK'));
  } catch (e) {
    console.error('listPublic event_pages', e);
    res.status(500).json(errorResponse('Failed to list event pages', e.message));
  }
};

const listAdmin = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);

    let q = supabaseAdmin
      .from('event_pages')
      .select('*', { count: 'exact' })
      .order('updated_at', { ascending: false });

    if (search) {
      q = q.or(`slug.ilike.%${search}%,title.ilike.%${search}%`);
    }

    const { data, error, count } = await q.range(offset, offset + lim - 1);

    if (error) {
      console.error('listAdmin event_pages:', error);
      return res.status(500).json(errorResponse('Failed to list event pages', error.message));
    }

    res.json(
      successResponse({
        pages: (data || []).map(mapRowToBackend),
        pagination: {
          page: parseInt(page, 10),
          limit: lim,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / lim),
        },
      })
    );
  } catch (e) {
    console.error('listAdmin event_pages', e);
    res.status(500).json(errorResponse('Failed to list event pages', e.message));
  }
};

const getByIdAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin.from('event_pages').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Event page not found'));
      }
      return res.status(500).json(errorResponse('Failed to load event page', error.message));
    }
    res.json(successResponse(mapRowToBackend(data)));
  } catch (e) {
    res.status(500).json(errorResponse('Failed to load event page', e.message));
  }
};

const slugify = (val) =>
  String(val || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const createPage = async (req, res) => {
  try {
    const {
      slug: rawSlug,
      status = 'draft',
      seo_title,
      seo_description,
      canonical_url,
      cms_data = {},
    } = req.body;

    const slug = slugify(rawSlug);
    if (!slug) {
      return res.status(400).json(errorResponse('Valid slug is required'));
    }

    const { data: exists } = await supabaseAdmin.from('event_pages').select('id').eq('slug', slug).maybeSingle();
    if (exists) {
      return res.status(400).json(errorResponse('An event page with this slug already exists'));
    }

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('event_pages')
      .insert({
        slug,
        title: seo_title || null,
        is_published: status === 'published',
        content: {
          seo_title: seo_title || null,
          seo_description: seo_description || null,
          canonical_url: canonical_url || null,
          cms_data: typeof cms_data === 'object' && cms_data !== null ? cms_data : {},
        },
        updated_at: now,
      })
      .select('*')
      .single();

    if (error) {
      console.error('createPage event_pages:', error);
      return res.status(500).json(errorResponse('Failed to create event page', error.message));
    }

    res.status(201).json(successResponse(mapRowToBackend(data), 'Created'));
  } catch (e) {
    res.status(500).json(errorResponse('Failed to create event page', e.message));
  }
};

const updatePage = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, seo_title, seo_description, canonical_url, cms_data } = req.body;

    const { data: existing, error: fe } = await supabaseAdmin.from('event_pages').select('*').eq('id', id).single();
    if (fe || !existing) {
      return res.status(404).json(errorResponse('Event page not found'));
    }

    const currentContent = existing.content || {};
    const update = { updated_at: new Date().toISOString() };
    const contentUpdate = { ...currentContent };

    if (status !== undefined) update.is_published = status === 'published';
    if (seo_title !== undefined) {
      update.title = seo_title;
      contentUpdate.seo_title = seo_title;
    }
    if (seo_description !== undefined) contentUpdate.seo_description = seo_description;
    if (canonical_url !== undefined) contentUpdate.canonical_url = canonical_url;
    if (cms_data !== undefined) {
      contentUpdate.cms_data = typeof cms_data === 'object' && cms_data !== null ? cms_data : {};
    }
    
    update.content = contentUpdate;

    const { data, error } = await supabaseAdmin.from('event_pages').update(update).eq('id', id).select('*').single();

    if (error) {
      return res.status(500).json(errorResponse('Failed to update event page', error.message));
    }
    res.json(successResponse(mapRowToBackend(data), 'Updated'));
  } catch (e) {
    res.status(500).json(errorResponse('Failed to update event page', e.message));
  }
};

const deletePage = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('event_pages').delete().eq('id', id);
    if (error) {
      return res.status(500).json(errorResponse('Failed to delete', error.message));
    }
    res.json(successResponse({ id }, 'Deleted'));
  } catch (e) {
    res.status(500).json(errorResponse('Failed to delete', e.message));
  }
};

module.exports = {
  getPublicBySlug,
  listPublic,
  listAdmin,
  getByIdAdmin,
  createPage,
  updatePage,
  deletePage,
};
