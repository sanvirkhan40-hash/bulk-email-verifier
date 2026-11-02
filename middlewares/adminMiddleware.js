// Single-email allowlist via ADMIN_EMAIL. This is an administrative gate for
// settings and backend management, not a general role system.
function isAdmin(req) {
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    return Boolean(
        adminEmail &&
        req.user &&
        String(req.user.email || '').trim().toLowerCase() === adminEmail
    );
}

function requireAdmin(req, res, next) {
    if (!isAdmin(req)) {
        return res.status(403).json({ message: 'Admin access required' });
    }
    return next();
}

module.exports = { isAdmin, requireAdmin };
