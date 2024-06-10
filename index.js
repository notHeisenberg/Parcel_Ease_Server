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
        app.get('/users', verifyToken, async (req, res) => {
            const { role } = req.query; // Get role from query parameters
            let query = {};

            // If role is provided in the query parameters, add it to the query
            if (role) {
                query.role = role;
            }

            try {
                const users = await userCollection.find(query).toArray();

                const usersWithBookings = await Promise.all(users.map(async (user) => {
                    const bookings = await bookingCollection.find({ email: user.email }).toArray();
                    const parcelsBooked = bookings.length;
                    const totalSpentAmount = bookings.reduce((total, booking) => total + booking.parcelWeight * booking.parcelPrice, 0); // Adjust the field name for amount as necessary
                    return {
                        ...user,
                        parcelsBooked,
                        totalSpentAmount
                    };
                }));

                res.send(usersWithBookings);
            } catch (error) {
                console.error('Error fetching users with bookings:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
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

        // Endpoint to update a user's role
        app.patch('/users/:id/role', verifyToken, async (req, res) => {
            const userId = req.params.id;
            const { role } = req.body;

            if (!role) {
                return res.status(400).send({ message: 'Role is required' });
            }

            try {
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: { role } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: 'User not found' });
                }

                res.send({ message: 'Role updated successfully' });
            } catch (error) {
                console.error('Error updating role:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });


        // Fetch delivery men with their reviews and average ratings
        app.get('/users/deliverymen', verifyToken, verifyAdmin, async (req, res) => {
            try {
                // Fetch all delivery men
                const deliverymen = await userCollection.find({ role: 'deliveryman' }).toArray();

                // Aggregate reviews to calculate average rating and review count for each delivery man
                const reviewsAggregation = [
                    {
                        $group: {
                            _id: "$deliveryMenId",
                            averageRating: { $avg: "$rating" },
                            reviewCount: { $sum: 1 }
                        }
                    }
                ];

                const reviews = await reviewCollection.aggregate(reviewsAggregation).toArray();

                // Map reviews to a dictionary for easy lookup
                const reviewsMap = reviews.reduce((acc, review) => {
                    acc[review._id.toString()] = review;
                    return acc;
                }, {});

                // Combine delivery men with their reviews and average ratings
                const deliveryMenWithReviews = deliverymen.map(deliveryMan => {
                    const review = reviewsMap[deliveryMan._id.toString()];
                    return {
                        ...deliveryMan,
                        averageRating: review ? review.averageRating.toFixed(1) : "N/A",
                        reviewCount: review ? review.reviewCount : 0
                    };
                });

                res.send(deliveryMenWithReviews);
            } catch (error) {
                console.error('Error fetching delivery men reviews:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });



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


        // Update booking status to 'cancelled' or 'delivered', and increment parcelDelivered
        app.patch('/deliveries/:id/:status', verifyToken, async (req, res) => {
            const id = req.params.id;
            const status = req.params.status;

            try {
                const query = { _id: new ObjectId(id) };

                // Update the booking status
                const updateDoc = { $set: { status } };

                // Perform the update on the booking
                const result = await bookingCollection.updateOne(query, updateDoc);

                if (status === 'delivered') {
                    // Find the booking to get the deliveryMenId
                    const booking = await bookingCollection.findOne(query);
                    if (!booking) {
                        return res.status(404).send({ message: 'Booking not found' });
                    }

                    // Increment parcelDelivered for the delivery man
                    await userCollection.updateOne(
                        { _id: new ObjectId(booking.deliveryMenId) },
                        { $inc: { parcelDelivered: 1 } }
                    );
                }

                res.send(result);
            } catch (error) {
                console.error('Error updating booking status:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
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
            const approximateDeliveryDate = req.body.approximateDeliveryDate;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status: 'on the way',
                    deliveryMenId: deliveryMenId,
                    approximateDeliveryDate: approximateDeliveryDate
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
        app.get('/reviews/deliveryman/:deliveryMenEmail', verifyToken, verifyDeliveryMan, async (req, res) => {
            const deliveryMenEmail = req.params.deliveryMenEmail;

            try {
                // First, find the delivery man's ID by email
                const deliveryMan = await userCollection.findOne({ email: deliveryMenEmail });

                if (!deliveryMan) {
                    return res.status(404).json({ message: 'Delivery man not found' });
                }

                const deliveryManId = deliveryMan._id.toString();

                // Use the delivery man's ID to search for reviews
                const reviews = await reviewCollection.find({ deliveryMenId: deliveryManId }).toArray();

                res.send(reviews);
            } catch (error) {
                console.error('Error fetching reviews:', error);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // stasticcs related api
        app.get('/statistics', async (req, res) => {
            try {
                // Total number of people using your app
                const totalUsers = await userCollection.countDocuments();

                // Total number of parcels booked
                const totalParcelsBooked = await bookingCollection.countDocuments();

                // Total number of parcels delivered
                const totalParcelsDelivered = await bookingCollection.countDocuments({ status: 'delivered' });

                // Fetch bookings by date
                const bookingsByDate = await bookingCollection.aggregate([
                    {
                        $group: {
                            _id: {
                                bookingDate: "$bookingDate" // Group by the bookingDate string as it is
                            },
                            count: { $sum: 1 }
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            date: "$_id.bookingDate",
                            count: 1
                        }
                    },
                    { $sort: { date: 1 } }
                ]).toArray();


                // Fetch delivered parcels by date
                const deliveredParcelsByDate = await bookingCollection.aggregate([
                    {
                        $match: { status: 'delivered' }
                    },
                    {
                        $group: {
                            _id: "$bookingDate",
                            count: { $sum: 1 }
                        }
                    },
                    { $sort: { "_id": 1 } }
                ]).toArray();


                // Merge bookings and delivered parcels by date
                const mergedData = bookingsByDate.map(booking => {
                    const delivered = deliveredParcelsByDate.find(delivered => delivered._id === booking.date);
                    return {
                        date: booking.date,
                        booked: booking.count,
                        delivered: delivered ? delivered.count : 0
                    };
                });

                // Prepare data for the line chart
                const lineChartData = {
                    labels: mergedData.map(item => item.date),
                    datasets: [
                        {
                            label: 'Booked Parcels',
                            borderColor: 'rgba(54, 162, 235, 1)',
                            backgroundColor: 'rgba(54, 162, 235, 0.2)',
                            fill: false,
                            data: mergedData.map(item => item.booked)
                        },
                        {
                            label: 'Delivered Parcels',
                            borderColor: 'rgba(255, 99, 132, 1)',
                            backgroundColor: 'rgba(255, 99, 132, 0.2)',
                            fill: false,
                            data: mergedData.map(item => item.delivered)
                        }
                    ]
                };

                res.send({
                    totalUsers,
                    totalParcelsBooked,
                    totalParcelsDelivered,
                    barChartData: bookingsByDate,
                    lineChartData
                });
            } catch (error) {
                console.error('Error fetching statistics:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });

        app.get('/top-delivery-men', async (req, res) => {
            try {
                // Fetch delivery men from the user collection
                const deliveryMen = await userCollection.find({ role: 'deliveryman' }).toArray();

                // Fetch reviews for delivery men from the reviews collection
                const reviews = await reviewCollection.find().toArray();

                // Calculate average rating for each delivery man
                const averageRatings = {};
                const parcelDeliveries = {};
                reviews.forEach(review => {
                    if (!averageRatings[review.deliveryMenId]) {
                        averageRatings[review.deliveryMenId] = { totalRating: 0, count: 0 };
                    }
                    averageRatings[review.deliveryMenId].totalRating += review.rating;
                    averageRatings[review.deliveryMenId].count++;
                });

                // Fetch the number of parcels delivered for each delivery man
                deliveryMen.forEach(deliveryMan => {
                    parcelDeliveries[deliveryMan._id.toString()] = deliveryMan.parcelDelivered || 0;
                });

                // Calculate average rating for each delivery man
                deliveryMen.forEach(deliveryMan => {
                    const deliveryManId = deliveryMan._id.toString();
                    const averageRatingData = averageRatings[deliveryManId];
                    deliveryMan.averageRating = averageRatingData ? averageRatingData.totalRating / averageRatingData.count : 0;
                    deliveryMan.parcelsBooked = parcelDeliveries[deliveryManId] || 0;
                });

                // Sort delivery men by the number of parcels they delivered and average ratings
                deliveryMen.sort((a, b) => {
                    // Sort by the number of parcels delivered (descending order)
                    if (a.parcelsBooked !== b.parcelsBooked) {
                        return b.parcelsBooked - a.parcelsBooked;
                    }
                    // If the number of parcels delivered is the same, sort by average ratings (descending order)
                    return b.averageRating - a.averageRating;
                });

                // Take the top 3 delivery men
                const top3DeliveryMen = deliveryMen.slice(0, 3);

                res.send(top3DeliveryMen);
            } catch (error) {
                console.error('Error fetching top delivery men:', error);
                res.status(500).send({ message: 'Internal server error' });
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