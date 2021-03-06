const DeviseTokenSale = artifacts.require("./DeviseTokenSale");
const DeviseRentalBase = artifacts.require("./DeviseRentalProxy");
const DeviseEternalStorage = artifacts.require("./DeviseEternalStorage");
const DeviseRental_v1 = artifacts.require("./test/DeviseRentalImplTest");
const DeviseToken = artifacts.require("./DeviseToken");
const DateTime = artifacts.require("./DateTime");
const moment = require('moment');
const {timeTravel, evmSnapshot, evmRevert, timestampToDate} = require('./test-utils');
const strategies = require('./strategies');
const assertRevert = require('./helpers/assertRevert');

const pitai = web3.eth.accounts[0];
const escrowWallet = web3.eth.accounts[1];
const revenueWallet = web3.eth.accounts[2];
const clients = web3.eth.accounts.slice(3);
let token;
let tokensale;
let rental;
let proxy;
let testSnapshotId = 0;
let estor;
let microDVZ = 10 ** 6;
let millionDVZ = 10 ** 6;

async function setupFixtures() {
    // Setup all the contracts
    const cap = 10 * 10 ** 9 * 10 ** 6;
    token = await DeviseToken.new(cap, {from: pitai});
    const initialRate = new web3.BigNumber(16000);
    const finalRate = new web3.BigNumber(8000);
    const blockNumber = web3.eth.blockNumber;
    const openingTime = web3.eth.getBlock(blockNumber).timestamp;
    const closingTime = openingTime + 360 * 24 * 60 * 60;
    tokensale = await DeviseTokenSale.new(pitai, initialRate, finalRate, openingTime, closingTime, token.address, {from: pitai});
    const tokenWallet = await tokensale.tokenWallet.call();
    // mint 1 billion tokens for token sale
    const saleAmount = 1 * 10 ** 9 * 10 ** 6;
    await token.mint(tokenWallet, saleAmount);
    await token.approve(tokensale.address, saleAmount, {from: tokenWallet});
    dateTime = await DateTime.deployed();
    estor = await DeviseEternalStorage.new();
    // Create new upgradeable contract frontend (proxy)
    proxy = await DeviseRentalBase.new(token.address, dateTime.address, estor.address, {from: pitai});
    // Set it's implementation version
    await proxy.upgradeTo('1', (await DeviseRental_v1.new()).address);
    await tokensale.setRentalProxy(proxy.address);
    // Use implementation functions with proxy address
    rental = DeviseRental_v1.at(proxy.address);
    await rental.setEscrowWallet(escrowWallet);
    await rental.setRevenueWallet(revenueWallet);

    const escrow_cap = 1000000000000000000 * microDVZ;
    await token.approve(rental.address, escrow_cap, {from: escrowWallet});

    // test addStrategy can't be called prior to authorize
    await assertRevert(rental.addStrategy(strategies[0], 1000000 * (3)));
    await estor.authorize(proxy.address);
    // Pit.AI adds strategies to rental contract
    await rental.addStrategy(strategies[0], 1000000 * (3));
    await rental.addStrategy(strategies[1], 1000000 * (3));
    await rental.addStrategy(strategies[2], 1000000 * (2));
    await rental.addStrategy(strategies[3], 1000000 * (2));
    await rental.addStrategy(strategies[4], 1000000 * (1));
    await rental.addStrategy(strategies[5], 1000000 * (1));
    // Some clients buy tokens and approve transfer to rental contract
    const ether_amount = 3000;
    await Promise.all(clients.map(async client => await tokensale.sendTransaction({
        from: client,
        value: web3.toWei(ether_amount, "ether"),
        gas: 1000000
    })));
    await Promise.all(clients.map(async client => await token.approve(rental.address, 30 * millionDVZ * microDVZ, {from: client})));
    // move forward 1 month
    await timeTravel(86400 * 31);
    // snapshot the blockchain
    testSnapshotId = (await evmSnapshot()).result;
}

async function getProratedDues(seats) {
    // mimic the price calculation used in solidity
    const price = (await rental.getRentPerSeatCurrentTerm.call()).toNumber() * seats;
    let d = timestampToDate(web3.eth.getBlock(web3.eth.blockNumber).timestamp);
    let daysInMonth = new Date(d.getYear(), d.getMonth() + 1, 0).getDate();
    return Math.floor((price / daysInMonth) * (daysInMonth - (moment(d).utc().date() - 1)));
}

contract("UpdateLeaseTerms", function () {
    // before running all tests, setup fixtures
    before(setupFixtures);
    // reset to our fixtures state after each test
    afterEach(async () => {
        evmRevert(testSnapshotId);
        // workaround ganache/testrpc crash
        testSnapshotId = (await evmSnapshot()).result;
    });


    it("getClientSummary returns correct information", async () => {
        const client = clients[0];
        const client_provision = millionDVZ * microDVZ;
        await rental.provision(client_provision, {from: client});
        await rental.applyForPowerUser({from: client});

        const clientInfo1 = await rental.getClientSummary(client);
        assert.equal(clientInfo1[0], client); // beneficiary
        assert.equal(clientInfo1[1].toNumber(), client_provision);  // escrow balance
        const tokenBalance = (await token.balanceOf(client)).toNumber();
        assert.equal(clientInfo1[2].toNumber(), tokenBalance);  // token balance
        assert.equal(clientInfo1[3].toNumber(), 0); // leaseTermPaid should be 0, none paid ever
        assert.equal(clientInfo1[4], true); // power user
        assert.equal(clientInfo1[5], false); // historical data access
        assert.equal(clientInfo1[6].toNumber(), 0); // currentTermSeats
        assert.equal(clientInfo1[7].toNumber(), 0); // indicativeNextTermSeats

        // test leaseAll can't be called if unauthorized
        await estor.unauthorize(proxy.address);
        await assertRevert(rental.leaseAll(10000 * microDVZ, 10, {from: client}));
        await estor.authorize(proxy.address);

        await rental.leaseAll(10000 * microDVZ, 10, {from: client});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client});
        const dues = await getProratedDues(10);
        const clientInfo2 = await rental.getClientSummary(client);
        assert.equal(clientInfo2[0], client);
        assert.equal(clientInfo2[1].toNumber(), client_provision - dues); // escrow balance
        assert.equal(clientInfo2[2].toNumber(), tokenBalance);
        assert.equal(clientInfo2[4], false); // client fell behind power user minimum
        assert.equal(clientInfo2[5], false); // historical data access
        assert.equal(clientInfo2[6].toNumber(), 10); // currentTermSeats
        assert.equal(clientInfo2[7].toNumber(), 10); // indicativeNextTermSeats
    });

    it("Provision updates allowance", async () => {
        const client = clients[0];
        assert.equal(await rental.getAllowance.call({from: client}), 0);
        // client provisions balance in rental contract
        await rental.provision(1000000, {from: client});
        // balance should now be up to date
        assert.equal(await rental.getAllowance.call({from: client}), 1000000);
        // client provisions balance in rental contract
        await rental.provision(1000000, {from: client});
        // balance should now be up to date
        assert.equal(await rental.getAllowance.call({from: client}), 2000000);
    });

    it("Provision should update lease terms before increasing allowance", async () => {
        const client = clients[0];
        assert.equal(await rental.getAllowance.call({from: client}), 0);
        // client provisions balance in rental contract and leases
        const dues = await getProratedDues(10);
        const client_privision = 300000 * microDVZ;
        await rental.provision(client_privision, {from: client});
        const client_bid = 2000 * microDVZ;
        await rental.leaseAll(client_bid, 10, {from: client});
        const allowance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(allowance, client_privision - dues);
        // cancel lease for future months
        await rental.leaseAll(client_bid, 0, {from: client});
        // time passes, move forward 6 months
        await timeTravel(86400 * 6 * 30);
        const more_provision = 2000 * microDVZ;
        await rental.provision(more_provision, {from: client});
        // we should only have gotten charged for the 1 term
        const currentBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(currentBalance, client_privision + more_provision - dues);
    });

    it("getAllowance updates all previous lease terms when contract state stale for 6 months", async () => {
        const client = clients[0];
        const initialAllowance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(initialAllowance, 0);
        // client provisions balance in rental contract and calls leaseAll
        const client_provision = 30000000 * microDVZ;
        const bal = (await token.balanceOf.call(client)).toNumber();
        assert.isAbove(bal, client_provision);
        await rental.provision(client_provision, {from: client});
        const postProvisionBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(postProvisionBalance, client_provision);
        // Lease 10 seats (should charge us first month's lease right away)
        const client_bid = 10000 * microDVZ;
        await rental.leaseAll(client_bid, 10, {from: client});
        const postLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.isBelow(postLeaseBalance, postProvisionBalance);
        // we start with prorated dues for the month in which we leased
        let d = timestampToDate(web3.eth.getBlock(web3.eth.blockNumber).timestamp);
        let daysInMonth = new Date(d.getYear(), d.getMonth() + 1, 0).getDate();
        let dues = await getProratedDues(10);
        for (let i = 0; i < 6; i++) {
            const balance = (await rental.getAllowance.call({from: client})).toNumber();
            // Add monthly dues every month after lease month
            if (i > 0) {
                const price = (await rental.getRentPerSeatCurrentTerm.call()).toNumber() * 10;
                dues += Math.floor(price);
            }
            // should equal original bal minus dues so far
            assert.equal(balance, postProvisionBalance - dues);
            // time passes (~1 months)
            const randomDay = Math.floor(Math.random() * Math.floor(28));
            await timeTravel(86400 * (randomDay + 1 + daysInMonth - d.getDate()));
            d = timestampToDate(web3.eth.getBlock(web3.eth.blockNumber).timestamp);
            daysInMonth = new Date(d.getYear(), d.getMonth() + 1, 0).getDate();
        }
    });

    it("leaseAll doesn't decrease allowance when seats not available", async () => {
        // Make sure we have enough clients in ganache to test this
        assert.isAbove(clients.length, 10);
        const provision_amount = millionDVZ * microDVZ;
        const client_bid = 10000 * microDVZ;
        // First 10 clients get 10 seats each maxing out the lease term
        await Promise.all(clients.slice(0, 10).map(async client => {
            await rental.provision(provision_amount, {from: client});
            const preLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
            assert.equal(preLeaseBalance, provision_amount);
            await rental.leaseAll(client_bid, 10, {from: client});
            const postLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
            assert.isBelow(postLeaseBalance, preLeaseBalance);
        }));
        // this is the client that won't be charged since she can't get seats
        const client = clients[11];
        await rental.provision(provision_amount, {from: client});
        const preLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
        await rental.leaseAll(client_bid, 10, {from: client});
        const postLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(preLeaseBalance, postLeaseBalance);
    });

    it("leaseAll checks if client has enough tokens to pay for lease", async () => {
        const provision_amount = millionDVZ * microDVZ;
        const client_bid = 10000 * microDVZ;
        // First 5 clients get 10 seats each
        await Promise.all(clients.slice(0, 5).map(async client => {
            await rental.provision(provision_amount, {from: client});
            const preLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
            assert.equal(preLeaseBalance, provision_amount);
            await rental.leaseAll(client_bid, 10, {from: client});
            const postLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
            assert.isBelow(postLeaseBalance, preLeaseBalance);
        }));
        // Next client doesn't provision enough so shouldn't get in
        const client = clients[5];
        const insuffient_amount = 10 * microDVZ;
        await rental.provision(insuffient_amount, {from: client});
        const preLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(preLeaseBalance, insuffient_amount);
        try {
            await rental.leaseAll(client_bid, 10, {from: client});
            assert.fail("Lease All didn't thrown when it should have");
        } catch (e) {
        }
        const postLeaseBalance = (await rental.getAllowance.call({from: client})).toNumber();
        assert.equal(postLeaseBalance, preLeaseBalance);
    });

    it("Price goes up on second term with 1 bidder", async () => {
        const client = clients[0];
        await rental.provision(200000 * microDVZ, {from: client});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client});
        assert((await rental.getRentPerSeatCurrentTerm.call()).toNumber(), 30);
        assert((await rental.getIndicativeRentPerSeatNextTerm.call()).toNumber(), 300000);
    });

    it("Price uses the right totalIncrementalUsefulness for price calculations", async () => {
        // lease by first client
        const client1 = clients[0];
        await rental.provision(1000000 * microDVZ, {from: client1});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client1});
        const client1Balance = (await rental.getAllowance.call({from: client1})).toNumber();

        // add a strategy to increse totalIncrementalUsefulness, current term price stays the same, next term increases in price
        const priceMonth1 = (await rental.getRentPerSeatCurrentTerm.call()).toNumber();
        const usefulness = Math.floor((await rental.getTotalIncrementalUsefulness()).toNumber() / 1000000);
        assert.equal((await rental.getIndicativeRentPerSeatNextTerm.call()).toNumber(), priceMonth1);
        await rental.addStrategy(strategies[6], 1000000 * (1));
        assert.equal(Math.floor((await rental.getTotalIncrementalUsefulness()).toNumber() / 1000000), usefulness + 1);
        assert.equal((await rental.getRentPerSeatCurrentTerm.call()).toNumber(), priceMonth1);

        // lease by second client, should get charged the same as first client
        const client2 = clients[1];
        await rental.provision(1000000 * microDVZ, {from: client2});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client2});
        const client2Balance = (await rental.getAllowance.call({from: client2})).toNumber();
        assert.equal(client1Balance, client2Balance);

        for (let i = 1; i <= 6; i++) {
            // time passes, move forward at least 1 month
            await timeTravel(86400 * 31);
            // Current price should include new usefulness
            const client1BalanceMonth2 = (await rental.getAllowance.call({from: client1})).toNumber();
            const client2BalanceMonth2 = (await rental.getAllowance.call({from: client2})).toNumber();
            assert.equal(client1BalanceMonth2, client2BalanceMonth2);
        }
    });

    it("updateLeaseTerms removes clients who run out of tokens", async () => {
        const provision_amount = millionDVZ * microDVZ;
        const client_bid = 10000 * microDVZ;
        // First 5 clients get 10 seats each
        let numSeats = 100;
        const goodClients = clients.slice(0, 5);
        await Promise.all(goodClients.map(async client => {
            await rental.provision(provision_amount, {from: client});
            await rental.leaseAll(client_bid, 10, {from: client});
            numSeats -= 10;
        }));
        const numSeatsAvailable = (await rental.getSeatsAvailable.call()).toNumber();
        assert.equal(numSeatsAvailable, numSeats);

        // this client only provisions enough for 1 term
        const client = clients[5];
        let dues = await getProratedDues(10);
        await rental.provision(dues, {from: client});
        await rental.leaseAll(client_bid, 10, {from: client});
        assert.equal((await rental.getNumberOfRenters.call()).toNumber(), 6);
        assert.equal((await rental.getSeatsAvailable.call()).toNumber(), numSeats - 10);

        // Jump forward to next month
        let d = timestampToDate(web3.eth.getBlock(web3.eth.blockNumber).timestamp);
        let daysInMonth = new Date(d.getYear(), d.getMonth() + 1, 0).getDate();
        await timeTravel(86400 * (1 + daysInMonth - d.getDate()));
        const numRenters = (await rental.getNumberOfRenters.call()).toNumber();
        assert.equal(numRenters, 5);
        const finalAvailableSeats = (await rental.getSeatsAvailable.call()).toNumber();
        assert.equal(finalAvailableSeats, numSeats);
        for (let i = 0; i < numRenters; i++) {
            const renter = await rental.getRenter.call(i);
            assert.include(goodClients, renter);
        }
    });

    it("Withdraw decreases allowance", async () => {
        const client = clients[0];
        await rental.provision(10000, {from: client});
        const allowanceBeforeWithdraw = await rental.getAllowance.call({from: client});
        assert.equal(allowanceBeforeWithdraw, 10000);
        await rental.withdraw(100, {from: client});
        const allowanceAfterWithdraw = await rental.getAllowance.call({from: client});
        assert.equal(allowanceAfterWithdraw, 9900);
    });

    it("getAllowance call() matches before and after updateLeaseTerm with contract stale for 6 months", async () => {
        const client = clients[0];
        // client provisions balance in rental contract and calls leaseAll
        await rental.provision(1000000 * microDVZ, {from: client});
        await rental.leaseAll(10000 * microDVZ, 10, {from: client});
        // time passes (~6 months)
        await timeTravel(86400 * 30 * 6);
        // client checks his own balance in a free call()
        const allowanceBeforeUpdate = await rental.getAllowance.call({from: client});
        // We make a transaction to update the contract's internal state
        await rental.updateLeaseTerms();
        // client checks his own balance in a free call()
        const allowanceAfterUpdate = await rental.getAllowance.call({from: client});
        assert.equal(allowanceBeforeUpdate.toNumber(), allowanceAfterUpdate.toNumber());
    });

    it("Client loses power user privileges if token drops below minimum power user balance", async () => {
        const provision_amount = millionDVZ * microDVZ;
        const client = clients[0];
        await rental.provision(provision_amount, {from: client});
        await rental.applyForPowerUser({from: client});
        assert.equal(await rental.isPowerUser.call({from: client}), true);
        const wd_amount = 100 * microDVZ;
        await rental.withdraw(wd_amount, {from: client});
        const allowanceAfterWithdraw = await rental.getAllowance.call({from: client});
        assert.equal(allowanceAfterWithdraw, provision_amount - wd_amount);
        assert.equal(await rental.isPowerUser.call({from: client}), false);
    });

    it("Cancelled leases do not count toward price", async () => {
        const provision_amount = 1000000 * microDVZ;
        const client_bid1 = 10000 * microDVZ;
        const client_bid2 = 6000 * microDVZ;
        await rental.provision(provision_amount, {from: clients[0]});
        await rental.provision(provision_amount, {from: clients[1]});
        await rental.provision(provision_amount, {from: clients[2]});
        await rental.leaseAll(client_bid1, 1, {from: clients[0]});
        await rental.leaseAll(client_bid1, 1, {from: clients[1]});
        await rental.leaseAll(client_bid2, 1, {from: clients[2]});
        const priceNextTerm = (await rental.getIndicativeRentPerSeatNextTerm.call()).toNumber();
        const totalIncrementalUsefulness = Math.floor((await rental.getTotalIncrementalUsefulness()).toNumber() / 1000000);
        assert.equal(priceNextTerm, client_bid1 * totalIncrementalUsefulness);
        await rental.leaseAll(client_bid1, 0, {from: clients[1]});
        const priceNextTerm2 = (await rental.getIndicativeRentPerSeatNextTerm.call()).toNumber();
        assert.equal(priceNextTerm2, client_bid2 * totalIncrementalUsefulness);
    });

    it("Provides a way to get all bids", async () => {
        const provision_amount = 1000000 * microDVZ;
        const client1 = clients[0];
        const client2 = clients[1];
        await rental.provision(provision_amount, {from: client1});
        await rental.provision(provision_amount, {from: client2});
        const client_bid1 = 10 * 10 ** 3 * microDVZ;
        const client_bid2 = 20 * 10 ** 3 * microDVZ;
        await rental.leaseAll(client_bid1, 5, {from: client1});
        await rental.leaseAll(client_bid2, 7, {from: client2});
        const secondClient = await rental.getHighestBidder.call();
        const firstClient = await rental.getNextHighestBidder.call(secondClient[0]);
        assert.equal(secondClient[0], client2);
        assert.equal(secondClient[1].toNumber(), 7);
        assert.equal(secondClient[2].toNumber(), client_bid2);
        assert.equal(firstClient[0], client1);
        assert.equal(firstClient[1].toNumber(), 5);
        assert.equal(firstClient[2].toNumber(), client_bid1);
    });

    it("Retains the same information after upgrade", async () => {
        const DeviseRental_v2 = artifacts.require("./DeviseRentalImplV2");
        await rental.provision(100000 * microDVZ, {from: clients[0]});
        await rental.provision(100000 * microDVZ, {from: clients[1]});
        await rental.leaseAll(10 * 10 ** 3 * microDVZ, 5, {from: clients[0]});
        await rental.leaseAll(20 * 10 ** 3 * microDVZ, 7, {from: clients[1]});
        await timeTravel(86400 * 30 * 6);
        const priceCurrentTerm = (await rental.getRentPerSeatCurrentTerm()).toNumber();
        const proxy = DeviseRentalBase.at(rental.address);
        await proxy.upgradeTo('2.0', (await DeviseRental_v2.new({from: pitai})).address, {from: pitai});
        const rental_v2 = DeviseRental_v2.at(rental.address);
        const priceCurrentTermPostUpgrade = (await rental_v2.getRentPerSeatCurrentTerm()).toNumber();
        assert.equal(priceCurrentTermPostUpgrade, priceCurrentTerm);
    });

    it("Can add new functions with upgrades", async () => {
        const provision_amount = 10000 * microDVZ;
        const DeviseRental_v2 = artifacts.require("./test/DeviseRentalImplV3");
        await rental.provision(provision_amount, {from: clients[0]});
        const bal_v1 = (await rental.getAllowance.call({from: clients[0]})).toNumber();
        // upgrade to v2
        const proxy = DeviseRentalBase.at(rental.address);
        await proxy.upgradeTo('2.0', (await DeviseRental_v2.new({from: pitai})).address, {from: pitai});
        const rental_v2 = DeviseRental_v2.at(proxy.address);
        const bal_v2 = (await rental_v2.getAllowance_v2.call({from: clients[0]})).toNumber();
        assert.equal(bal_v1, bal_v2);
    });

    it("Can change the implementation of existing functions", async () => {
        // upgrade to v2
        const DeviseRental_v2 = artifacts.require("./test/DeviseRentalImplV2");
        await proxy.upgradeTo('2.0', (await DeviseRental_v2.new({from: pitai})).address, {from: pitai});
        const rental_v2 = DeviseRental_v2.at(proxy.address);
        await rental_v2.provision(10000, {from: clients[0]});
        const bal_v2 = (await rental_v2.getAllowance.call({from: clients[0]})).toNumber();
        assert.equal(bal_v2, 9998);
    });

    it("Cannot override the type of state variables with upgrades", async () => {
        const DeviseRental_v3 = artifacts.require("./test/DeviseRentalImplV3");
        await proxy.upgradeTo('2.0', (await DeviseRental_v3.new({from: pitai})).address, {from: pitai});
        const rental_v3 = DeviseRental_v3.at(proxy.address);
        // can't work without Proxy fallback assembly
        await rental_v3.setVersion(3, {from: pitai});
        const testString1 = await proxy.version.call({from: clients[0]});
        assert.equal(testString1, "2.0");
    });

    it("Cannot override state variables with new same type variable in upgrades", async () => {
        const DeviseRental_v3 = artifacts.require("./test/DeviseRentalImplV3");
        await proxy.upgradeTo('2.0', (await DeviseRental_v3.new({from: pitai})).address, {from: pitai});
        const rental_v3 = DeviseRental_v3.at(proxy.address);
        const seats = (await rental_v3.getSeatsAvailable.call({from: clients[0]})).toNumber();
        assert.equal(seats, 100);
        const seats2 = (await rental_v3.getSeatsAvailable.call({from: clients[0]})).toNumber();
        assert.equal(seats2, 100);
    });


    it("Only owner can upgrade contract", async () => {
        const DeviseRental_v3 = artifacts.require("./test/DeviseRentalImplV3");
        await proxy.upgradeTo('2.0', (await DeviseRental_v3.new({from: pitai})).address, {from: pitai});
        try {
            await proxy.upgradeTo('2.0', (await DeviseRental_v3.new({from: pitai})).address, {from: clients[0]});
            expect.fail(null, null, "Only owner should be able to upgrade contract");
        } catch (e) {
        }
    });

    it("Deducts the right power user fee", async () => {
        const provision_amount = 10 * millionDVZ * microDVZ;
        const club_fee = 10000 * microDVZ;
        await rental.setPowerUserClubFee(club_fee, {from: pitai});
        await rental.provision(provision_amount, {from: clients[0]});
        const bal1 = (await rental.getAllowance.call({from: clients[0]})).toNumber();
        assert.equal(bal1, provision_amount);
        await rental.applyForPowerUser({from: clients[0]});
        const bal2 = (await rental.getAllowance.call({from: clients[0]})).toNumber();
        assert.equal(bal2, provision_amount - club_fee);
    });

    it("Uses the right historical data fee", async () => {
        const provision_amount = 10 * millionDVZ * microDVZ;
        const club_fee = 10000 * microDVZ;
        await rental.setHistoricalDataFee(club_fee, {from: pitai});
        await rental.provision(provision_amount, {from: clients[0]});
        const bal1 = (await rental.getAllowance.call({from: clients[0]})).toNumber();
        assert.equal(bal1, provision_amount);
        await rental.requestHistoricalData({from: clients[0]});
        const bal2 = (await rental.getAllowance.call({from: clients[0]})).toNumber();
        assert.equal(bal2, provision_amount - club_fee);
    });

    it("Can list all strategies in the blockchain", async () => {
        const numStrats = (await rental.getNumberOfStrategies.call()).toNumber();
        assert.equal(numStrats, 6);
        for (let i = 0; i < numStrats; i++) {
            const strat = await rental.getStrategy(i);
            assert.equal(strat[1] + strat[0], strategies[i]);
        }
    });

    it("Can get data contract", async function () {
        const dataConract = await rental.getDataContract.call();
        assert.equal(dataConract, estor.address);
    });

    it("Can set new data contract", async function () {
        estor = await DeviseEternalStorage.new();
        await rental.setDataContract(estor.address);
        const dataConract = await rental.getDataContract.call();
        assert.equal(dataConract, estor.address);
    });

    it("Can get the current number of seats leased", async function () {
        await rental.provision(100000 * microDVZ, {from: clients[0]});
        await rental.provision(100000 * microDVZ, {from: clients[1]});
        await rental.leaseAll(10 * 10 ** 3 * microDVZ, 5, {from: clients[0]});
        await rental.leaseAll(20 * 10 ** 3 * microDVZ, 7, {from: clients[1]});

        const client1Seats = (await rental.getCurrentTermSeats.call({from: clients[0]})).toNumber();
        assert.equal(5, client1Seats);
        const client2Seats = (await rental.getCurrentTermSeats.call({from: clients[1]})).toNumber();
        assert.equal(7, client2Seats);
    });


    it("Can get the next term's number of seats leased", async function () {
        await rental.provision(100000 * microDVZ, {from: clients[0]});
        await rental.provision(10000000 * microDVZ, {from: clients[1]});
        await rental.leaseAll(10 * 10 ** 3 * microDVZ, 5, {from: clients[0]});
        await rental.leaseAll(20 * 10 ** 3 * microDVZ, 7, {from: clients[1]});

        const client1Seats = (await rental.getNextTermSeats.call({from: clients[0]})).toNumber();
        assert.equal(0, client1Seats);
        const client2Seats = (await rental.getNextTermSeats.call({from: clients[1]})).toNumber();
        assert.equal(7, client2Seats);
    });

    it("Can return the current lease term index", async function () {
        // compare the up to date least term getter with the public variable value
        const leaseTerm = (await rental.getCurrentLeaseTerm()).toNumber();
        await rental.updateLeaseTerms();
        const publicLeaseTerm = (await rental.leaseTerm()).toNumber();
        const idx = moment([2018, 1, 1]).diff(moment(new Date()), 'months', true);
        assert.isAbove(leaseTerm, idx);
        assert.equal(publicLeaseTerm, leaseTerm);
    });
});
