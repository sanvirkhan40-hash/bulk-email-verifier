const loginForm = document.getElementById('loginForm');

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        try {
            const res = await axios.post('/api/auth/login', {
                email: document.getElementById('email').value,
                password: document.getElementById('password').value,
            });

            localStorage.setItem('token', res.data.token);
            localStorage.setItem('user', JSON.stringify({
                name: res.data.name,
                email: res.data.email
            }));

            window.location.href = '/dashboard.html';
        } catch (err) {
            showToast(err.response?.data?.message || 'Login failed', 'error');
        }
    });
