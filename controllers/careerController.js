const { supabaseAdmin } = require('../config/supabase');

const successResponse = (message, data = null) => ({
  success: true,
  message,
  data,
});

const errorResponse = (message, error = null, statusCode = 500) => ({
  success: false,
  message,
  error,
  statusCode,
});

const generateSlug = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

// GET /api/careers (public + admin, with filters)
const getAllCareers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status = 'open',
      search = '',
      department = '',
      location = '',
    } = req.query;

    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('careers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const isAdminContext = !!req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');

    if (!isAdminContext) {
      query = query.eq('status', 'open');
    } else if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(
        `title.ilike.%${search}%,short_description.ilike.%${search}%,department.ilike.%${search}%`
      );
    }
    if (department) {
      query = query.eq('department', department);
    }
    if (location) {
      query = query.eq('location', location);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json(
      successResponse('Careers retrieved successfully', {
        careers: data || [],
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit),
        },
      })
    );
  } catch (error) {
    console.error('Error fetching careers:', error);
    res.status(500).json(errorResponse('Failed to fetch careers', error.message));
  }
};

// GET /api/careers/slug/:slug (public)
const getCareerBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const { data, error } = await supabaseAdmin
      .from('careers')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'open')
      .single();

    if (error || !data) {
      return res.status(404).json(errorResponse('Career not found'));
    }

    res.json(successResponse('Career retrieved successfully', data));
  } catch (error) {
    console.error('Error fetching career by slug:', error);
    res.status(500).json(errorResponse('Failed to fetch career', error.message));
  }
};

// GET /api/careers/admin/:id (admin)
const getCareerById = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('careers')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json(errorResponse('Career not found'));
    }

    res.json(successResponse('Career retrieved successfully', data));
  } catch (error) {
    console.error('Error fetching career by id:', error);
    res.status(500).json(errorResponse('Failed to fetch career', error.message));
  }
};

// POST /api/careers/admin
const createCareer = async (req, res) => {
  try {
    const {
      title,
      slug: providedSlug,
      short_description,
      description,
      location,
      employment_type,
      department,
      experience_level,
      min_experience_years,
      max_experience_years,
      application_email,
      application_url,
      is_remote = false,
      is_featured = false,
      status = 'draft',
      seo_title,
      seo_description,
      responsibilities,
      requirements,
      benefits,
    } = req.body;

    if (!title || !description) {
      return res.status(400).json(errorResponse('Title and description are required'));
    }

    let slug = providedSlug ? generateSlug(providedSlug) : generateSlug(title);

    const { data: existing } = await supabaseAdmin
      .from('careers')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (existing) {
      let counter = 1;
      let newSlug = `${slug}-${counter}`;
      while (true) {
        const { data: slugCheck } = await supabaseAdmin
          .from('careers')
          .select('id')
          .eq('slug', newSlug)
          .maybeSingle();
        if (!slugCheck) break;
        counter += 1;
        newSlug = `${slug}-${counter}`;
      }
      slug = newSlug;
    }

    const normalizeInt = (value) => {
      if (value === undefined || value === null || value === '') return null;
      const num = Number(value);
      return Number.isNaN(num) ? null : num;
    };

    const published_at = status === 'open' ? new Date().toISOString() : null;

    const { data, error } = await supabaseAdmin
      .from('careers')
      .insert([
        {
          title,
          slug,
          short_description,
          description,
          location,
          employment_type,
          department,
          experience_level,
          min_experience_years: normalizeInt(min_experience_years),
          max_experience_years: normalizeInt(max_experience_years),
          application_email,
          application_url,
          is_remote,
          is_featured,
          status,
          seo_title,
          seo_description,
          responsibilities,
          requirements,
          benefits,
          published_at,
        },
      ])
      .select('*')
      .single();

    if (error) throw error;

    res.status(201).json(successResponse('Career created successfully', data));
  } catch (error) {
    console.error('Error creating career:', error);
    res.status(500).json(errorResponse('Failed to create career', error.message));
  }
};

// PUT /api/careers/admin/:id
const updateCareer = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updated_at: new Date().toISOString() };

    if (updates.title && !updates.slug) {
      updates.slug = generateSlug(updates.title);
    }

    if (updates.slug) {
      const normalizedSlug = generateSlug(updates.slug);
      const { data: slugExists } = await supabaseAdmin
        .from('careers')
        .select('id')
        .eq('slug', normalizedSlug)
        .neq('id', id)
        .maybeSingle();
      if (slugExists) {
        return res
          .status(400)
          .json(errorResponse('Slug already exists. Please choose a different one.'));
      }
      updates.slug = normalizedSlug;
    }

    if (updates.status) {
      if (updates.status === 'open') {
        updates.published_at = new Date().toISOString();
      } else if (updates.status !== 'open') {
        updates.published_at = null;
      }
    }

    const { data, error } = await supabaseAdmin
      .from('careers')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    res.json(successResponse('Career updated successfully', data));
  } catch (error) {
    console.error('Error updating career:', error);
    res.status(500).json(errorResponse('Failed to update career', error.message));
  }
};

// DELETE /api/careers/admin/:id
const deleteCareer = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('careers').delete().eq('id', id);
    if (error) throw error;
    res.json(successResponse('Career deleted successfully'));
  } catch (error) {
    console.error('Error deleting career:', error);
    res.status(500).json(errorResponse('Failed to delete career', error.message));
  }
};

module.exports = {
  getAllCareers,
  getCareerBySlug,
  getCareerById,
  createCareer,
  updateCareer,
  deleteCareer,
};

