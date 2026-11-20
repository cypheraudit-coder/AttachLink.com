const mysql = require('mysql2');

// Create the connection pool to your XAMPP MySQL database
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',         // Default XAMPP MySQL username is 'root'
    password: '',         // Default XAMPP MySQL password is blank
    database: 'attachment_portal' // The database we created earlier
});

// Test the connection
db.connect((err) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL Database: attachment_portal');
});

module.exports = db;