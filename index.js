const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 5000;

// middleware
app.use(
    cors({
        origin: [
            "http://localhost:5173",
            "https://parcel-ease.web.app"

        ]
    })
);
app.use(express.json());



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pgsiu4c.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const userCollection = client.db("parcelEaseDb").collection("users")
        const bookingCollection = client.db("parcelEaseDb").collection("bookings")
        const reviewCollection = client.db("parcelEaseDb").collection("reviews");

        // jwt related api
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        })

        // middlewares 
        const verifyToken = (req, res, next) => {
            // console.log('inside verify token', req.headers.authorization);
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' })
                }
                req.decoded = decoded;
                next();
            })
        }

        // use verify admin after verifyToken
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        }

        // use verify delivery man after verifyToken
        const verifyDeliveryMan = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isDeliveryMan = user?.role === 'deliveryman';
            if (!isDeliveryMan) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        }


        // users related api
        app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray();
            res.send(result);
        });

        app.post('/users', async (req, res) => {
            const user = req.body;
            // console.log(user)
            // insert email if user doesnt exists: 
            // you can do this many ways (1. email unique, 2. upsert 3. simple checking)
            const query = { email: user.email }
            const existingUser = await userCollection.findOne(query);
            if (existingUser) {
                return res.send({ message: 'user already exists', insertedId: null })
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        });

        // check user isAdmin
        app.get('/users/admin/:email', verifyToken, async (req, res) => {
            const email = req.params.email;

            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email };
            const user = await userCollection.findOne(query);
            let admin = false;
            if (user) {
                admin = user?.role === 'admin';
            }
            res.send({ admin });
        })

        // API endpoint to get users with role 'deliveryman'
        app.get('/users/deliverymen', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const query = { role: 'deliveryman' };
                const deliverymen = await userCollection.find(query).toArray();
                res.send(deliverymen);
            } catch (error) {
                res.status(500).send({ message: 'Failed to fetch deliverymen' });
            }
        });

        // check user isDeliveryMan
        app.get('/users/deliveryman/:email', verifyToken, async (req, res) => {
            const email = req.params.email;

            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email };
            const user = await userCollection.findOne(query);
            let deliveryman = false;
            if (user) {
                deliveryman = user?.role === 'deliveryman';
            }
            res.send({ deliveryman });
        })

        // Fetch bookings assigned to a specific delivery man using email
        app.get('/deliveries/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const user = await userCollection.findOne({ email });
            if (!user || user.role !== 'deliveryman') {
                return res.status(404).send({ message: 'Delivery man not found' });
            }
            const query = { deliveryMenId: user._id.toString(), status: { $ne: 'cancelled' } };
            const parcels = await bookingCollection.find(query).toArray();
            res.send(parcels);
        });

        // Update booking status to 'cancelled' or 'delivered'
        app.patch('/deliveries/:id/:status', verifyToken, async (req, res) => {
            const id = req.params.id;
            const status = req.params.status;
            const query = { _id: new ObjectId(id) };
            const updateDoc = { $set: { status: status } };
            const result = await bookingCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        // parcel booking api
        app.get('/bookings/:email', verifyToken, async (req, res) => {
            const query = { email: req.params.email }
            if (req.params.email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const result = await bookingCollection.find(query).toArray();
            res.send(result);
        });

        app.get('/bookings', verifyToken, verifyAdmin, async (req, res) => {
            const result = await bookingCollection.find().toArray();
            res.send(result);
        })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            booking.status = 'pending';
            const result = await bookingCollection.insertOne(booking);
            res.send(result);
        });

        app.patch('/bookings/update/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const booking = req.body;
            // console.log(booking,id)

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ error: 'Invalid booking ID format' });
            }

            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    displayName: booking.displayName,
                    email: booking.email,
                    userPhoneNumber: booking.userPhoneNumber,
                    recieverName: booking.recieverName,
                    recieverPhoneNumber: booking.recieverPhoneNumber,
                    parcelType: booking.parcelType,
                    parcelWeight: booking.parcelWeight,
                    parcelPrice: booking.parcelPrice,
                    deliveryAddressLatitude: booking.deliveryAddressLatitude,
                    deliveryAddressLongitude: booking.deliveryAddressLongitude,
                    parcelDeliveryAddress: booking.parcelDeliveryAddress,
                    requestedDeliveryDate: booking.requestedDeliveryDate,
                    bookingDate: booking.bookingDate
                }

            };
            // console.log(updateDoc)
            const result = await bookingCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        app.patch('/bookings/cancel/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: { status: 'cancelled' },
            };
            const result = await bookingCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        app.patch('/bookings/manage/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const deliveryMenId = req.body.deliveryMenId;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status: 'on the way',
                    deliveryMenId: deliveryMenId
                },
            };
            const result = await bookingCollection.updateOne(query, updateDoc);
            res.send(result);
        });

        // Review API
        // POST endpoint to save a new review
        app.post('/reviews', async (req, res) => {
            const review = req.body;

            // Input validation (you can add more validation as needed)
            if (!review.userName || !review.userImage || !review.rating || !review.feedback || !review.deliveryMenId || !review.parcelId) {
                return res.status(400).json({ message: 'All fields are required' });
            }

            try {
                // Check if a review already exists for the given parcel
                const existingReview = await reviewCollection.findOne({ parcelId: review.parcelId });
                if (existingReview) {
                    return res.status(400).json({ message: 'A review for this parcel already exists' });
                }

                // If no existing review found, insert the new review
                review.createdAt = new Date();
                const result = await reviewCollection.insertOne(review);
                res.status(201).send(result);
            } catch (error) {
                console.error('Error saving review:', error);
                res.status(500).json({ message: 'Server error' });
            }
        });


        // GET endpoint to fetch reviews for a specific delivery man
        app.get('/reviews/:deliveryMenId', async (req, res) => {
            const deliveryMenId = req.params.deliveryMenId;
            const query = { deliveryMenId: deliveryMenId };
            try {
                const reviews = await reviewCollection.find(query).toArray();
                res.send(reviews);
            } catch (error) {
                console.error('Error fetching reviews:', error);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('paecel ease is running')
})

app.listen(port, () => {
    console.log(`Parcel ease is running on port ${port}`);
})