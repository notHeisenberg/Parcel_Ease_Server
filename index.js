const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

// middleware
app.use(
    cors({
        origin: [
            "http://localhost:5000",

        ]
    })
);
app.use(express.json());



app.get('/', (req, res) => {
    res.send('paecel ease is running')
})

app.listen(port, () => {
    console.log(`Parcel ease is running on port ${port}`);
})